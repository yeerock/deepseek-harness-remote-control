#!/usr/bin/env node
/**
 * Set up the FIRST computer (the host): the edge every other computer joins.
 * macOS only (launchd). Run by `install.sh host <tag>`; safe to run again.
 *
 *   node scripts/host-setup.mjs [--tag vX.Y.Z] [--hostname dsh-rc]
 *
 * 1. Tailscale: installs it with Homebrew if missing, runs its daemon as a
 *    user launchd agent, signs in (the person opens one link, once).
 * 2. Funnel: publishes the edge at https://<name>.<tailnet>.ts.net (the
 *    person approves Funnel once, if the tailnet has not enabled it yet).
 * 3. Edge: builds it and runs it as a launchd agent with auto-approval, plus
 *    the watchdog that reopens DeepSeek Harness (scripts/install-macos.sh).
 * 4. Owner: completes /setup with a generated password, saved to
 *    ~/.dsh-rc/owner-password.txt (0600). Never printed.
 * 5. Plugin: installs DSH RC into DeepSeek Harness pointed at the local edge
 *    (scripts/join-edge.mjs), which restarts DeepSeek Harness.
 *
 * Lines starting "ACTION NEEDED:" are the only human steps; the script waits
 * for them and continues by itself.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const tag = valueOf('--tag') ?? process.env.DSHRC_TAG ?? '';
const tsHostname = (valueOf('--hostname') ?? process.env.DSHRC_TS_HOSTNAME ?? 'dsh-rc').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'dsh-rc';
const state = join(homedir(), '.dsh-rc');
const tsDir = join(state, 'tailscale');
const sock = join(tsDir, 'tailscaled.sock');
const edgeData = join(state, 'edge');
// Test-only overrides (honoured only with DSHRC_TEST=1) let a sandbox run this without touching the real host.
const testing = process.env.DSHRC_TEST === '1';
const env = testing ? process.env : {};
const agents = env.DSHRC_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
const launchctl = env.DSHRC_LAUNCHCTL ?? 'launchctl';
const PORT = env.DSHRC_EDGE_PORT ?? '8787';
const LOCAL_EDGE = `http://127.0.0.1:${PORT}`;
const marker = join(state, 'host.json');
const WAIT_MS = 15 * 60_000;

const log = (m) => process.stdout.write(`[dsh-rc host] ${m}\n`);
const fail = (m) => { process.stderr.write(`[dsh-rc host] ${m}\n`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...opts });

if (platform() !== 'darwin') fail('ACTION NEEDED: the host (the computer that runs the edge) must be a Mac. Set up a Mac first, then join this computer with the setup prompt from its Remote Control panel.');
if (tag !== '' && !/^v\d+\.\d+\.\d+$/.test(tag)) fail(`not a release tag: ${tag}`);
if (!/^\d{2,5}$/.test(PORT)) fail(`not a port: ${PORT}`);
// Never take over a host this script did not set up (for example one run from a development copy).
if (existsSync(join(agents, 'com.dshrc.edge.plist')) && !existsSync(marker) && process.env.DSHRC_FORCE !== '1') {
  fail('ACTION NEEDED: this Mac already runs a DSH RC edge that was set up another way. It was left untouched. To replace it, run the setup command again with DSHRC_FORCE=1 in front of sh.');
}
mkdirSync(state, { recursive: true, mode: 0o700 });
// Claim the host now, so a retry after a partial failure is recognised as ours.
if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify({ stage: 'started', repo, tag, at: Date.now() })}\n`, { mode: 0o600 });
mkdirSync(tsDir, { recursive: true, mode: 0o700 });

const find = (name) => [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/sbin/${name}`, `/usr/local/sbin/${name}`].find((p) => existsSync(p));
const ts = (args, opts) => run(tailscaleBin, [`--socket=${sock}`, ...args], opts);

// 1. Tailscale binaries
let tailscaleBin = env.DSHRC_TAILSCALE ?? find('tailscale');
let tailscaled = env.DSHRC_TAILSCALED ?? find('tailscaled');
if (tailscaleBin === undefined || tailscaled === undefined) {
  const brew = find('brew');
  if (brew === undefined) fail('ACTION NEEDED: install Homebrew from https://brew.sh (one command in Terminal), then run the setup command again.');
  log('installing Tailscale with Homebrew');
  run(brew, ['install', 'tailscale'], { stdio: 'inherit', timeout: 15 * 60_000 });
  tailscaleBin = find('tailscale');
  tailscaled = find('tailscaled');
  if (tailscaleBin === undefined || tailscaled === undefined) fail('Tailscale did not install; run the setup command again');
}

// The daemon as a user launchd agent (userspace networking, no sudo).
const tsPlist = join(agents, 'com.dshrc.tailscaled.plist');
const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshrc.tailscaled</string>
  <key>ProgramArguments</key><array>
    <string>${tailscaled}</string>
    <string>--tun=userspace-networking</string>
    <string>--state=${join(tsDir, 'tailscaled.state')}</string>
    <string>--socket=${sock}</string>
    <string>--port=41641</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(tsDir, 'tailscaled.log')}</string>
  <key>StandardErrorPath</key><string>${join(tsDir, 'tailscaled.log')}</string>
</dict></plist>
`;
mkdirSync(agents, { recursive: true });
const uid = String(process.getuid?.() ?? '');
if (!existsSync(tsPlist) || readFileSync(tsPlist, 'utf8') !== plistXml) {
  writeFileSync(tsPlist, plistXml);
  try { run(launchctl, ['bootout', `gui/${uid}`, tsPlist]); } catch { /* not loaded */ }
  run(launchctl, ['bootstrap', `gui/${uid}`, tsPlist]);
  log('Tailscale daemon started');
}

const tsStatus = () => { try { return JSON.parse(ts(['status', '--json'])); } catch { return undefined; } };
for (let i = 0; i < 30 && tsStatus() === undefined; i += 1) await sleep(1000);
if (tsStatus() === undefined) fail('the Tailscale daemon did not start; run the setup command again');

/** Run a Tailscale command that may print a link for the person; relay it and wait. */
async function withApproval(args, done, what) {
  if (await done()) return;
  const child = spawn(tailscaleBin, [`--socket=${sock}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let shown = false;
  const onText = (chunk) => {
    const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(String(chunk))?.[0];
    if (url !== undefined && !shown) {
      shown = true;
      log(`ACTION NEEDED: ${what}: open ${url} in a browser and approve. This script waits and continues by itself.`);
    }
  };
  let output = '';
  let exited = false;
  const collect = (chunk) => { output = (output + String(chunk)).slice(-2000); onText(chunk); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', () => { exited = true; });
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    if (await done()) { child.kill(); return; }
    // Tailscale gave up without a link (policy, certificates off, ...): say why now, not in 15 minutes.
    if (exited) { await sleep(3000); if (await done()) return; fail(`${what} failed: ${output.trim().split('\n').slice(-3).join(' ') || 'no output'}`); }
    await sleep(3000);
  }
  child.kill();
  fail(`${what} was not approved within 15 minutes; run the setup command again`);
}

// 2. Sign in, then Funnel
await withApproval(['up', `--hostname=${tsHostname}`], async () => tsStatus()?.BackendState === 'Running', 'sign this Mac in to Tailscale (once)');
const dnsName = String(tsStatus()?.Self?.DNSName ?? '').replace(/\.$/, '');
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(dnsName)) fail('could not read this Mac\'s Tailscale name; run the setup command again');
const publicUrl = `https://${dnsName}`;

// 3. Edge + watchdog (existing installer; it reloads the same Tailscale agent).
const node = process.execPath;
const npm = join(dirname(node), 'npm');
log('installing dependencies');
run(existsSync(npm) ? npm : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: repo, stdio: 'inherit', timeout: 20 * 60_000, env: { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ''}` } });
run('sh', [env.DSHRC_INSTALL_MACOS ?? join(repo, 'scripts', 'install-macos.sh')], {
  stdio: 'inherit', timeout: 20 * 60_000,
  env: { ...process.env, DSHRC_SKIP_TAILSCALED: '1', DSHRC_NODE: node, DSHRC_PUBLIC_URL: publicUrl, DSHRC_TAILSCALE: tailscaleBin, DSHRC_TAILSCALED: tailscaled, PATH: `${dirname(node)}:${process.env.PATH ?? ''}` },
});

const health = async () => { try { return await (await fetch(`${LOCAL_EDGE}/healthz`, { signal: AbortSignal.timeout(3000) })).json(); } catch { return undefined; } };
let h;
for (let i = 0; i < 60 && (h = await health()) === undefined; i += 1) await sleep(1000);
if (h === undefined) fail(`the edge did not start; see ${join(edgeData, 'edge.log')} and run the setup command again`);
// Publish only a DSH RC edge: something else on this port must never reach the internet.
if (h.status !== 'ok' || typeof h.setupComplete !== 'boolean') fail(`port ${PORT} answers, but not as a DSH RC edge; nothing was published`);
const funnelOn = async () => { try { return new RegExp(`127\\.0\\.0\\.1:${PORT}\\b|localhost:${PORT}\\b`).test(ts(['funnel', 'status'])); } catch { return false; } };
await withApproval(['funnel', '--bg', PORT], funnelOn, 'turn on Tailscale Funnel for this Mac (once)');
log(`public address ${publicUrl}`);

// 4. Owner account (first run only)
const passwordFile = join(state, 'owner-password.txt');
if (h.setupComplete !== true) {
  const edgeLog = env.DSHRC_EDGE_LOG ?? join(edgeData, 'edge.log');
  const latestCode = () => (existsSync(edgeLog) ? readFileSync(edgeLog, 'utf8').split('\n') : []).map((l) => /DSH RC setup code: (\S+)/.exec(l)?.[1]).filter(Boolean).pop();
  const password = existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8').trim() : randomBytes(18).toString('base64url');
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  chmodSync(passwordFile, 0o600);
  // Over loopback (a fresh Funnel name can take a minute to resolve); Origin is the public address the edge expects.
  const ownerSetup = async (code) => {
    const page = await fetch(`${LOCAL_EDGE}/setup`);
    const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
    return fetch(`${LOCAL_EDGE}/setup`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: publicUrl, cookie, 'x-csrf-token': csrf },
      body: new URLSearchParams({ code, csrf, password }),
    });
  };
  let done;
  // The edge prints a new code each boot; if it restarted in between, read the newest code and try once more.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(3000);
    const code = latestCode();
    if (code === undefined) continue;
    done = await ownerSetup(code);
    if (done.status === 303) break;
  }
  if (done?.status !== 303) fail(`owner setup failed (${done === undefined ? 'no setup code in the edge log' : `HTTP ${String(done.status)}`}); run the setup command again`);
  log(`owner account created; password saved to ${passwordFile} (only you can read it)`);
} else {
  log('owner account already set up');
}

// 5. Plugin into DeepSeek Harness, pointed at the local edge (restarts DeepSeek Harness).
const joinArgs = [join(repo, 'scripts', 'join-edge.mjs'), LOCAL_EDGE];
if (tag !== '') joinArgs.push('--tag', tag);
try {
  execFileSync(node, joinArgs, { stdio: 'inherit', timeout: 20 * 60_000 });
} catch {
  fail('installing the plugin failed (see above); fix the cause and run the setup command again');
}
writeFileSync(marker, `${JSON.stringify({ stage: 'ready', publicUrl, repo, tag, at: Date.now() })}\n`, { mode: 0o600 });
log(`HOST READY: ${publicUrl}`);
log('Other computers: in DeepSeek Harness here, open Remote Control, press Build Setup Prompt, and paste that prompt on each one.');
