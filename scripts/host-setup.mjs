#!/usr/bin/env node
/**
 * Set up the FIRST computer (the host): the edge every other computer joins.
 * macOS, Linux and Windows. Run by `install.sh host <tag>` or
 * `install.ps1` with DSHRC_MODE=host; safe to run again.
 *
 *   node scripts/host-setup.mjs [--tag vX.Y.Z] [--hostname dsh-rc]
 *
 * 1. Tailscale: installed if missing (macOS Homebrew; Linux the official
 *    static build, checksum-checked, no sudo; Windows winget), its daemon kept
 *    running, and this computer signed in (the person opens one link, once).
 * 2. Edge: built and run as a per-user service with auto-approval
 *    (macOS launchd via install-macos.sh; Linux systemd --user, cron fallback;
 *    Windows a Scheduled Task at sign-in), restarted if it stops.
 * 3. Funnel: publishes the edge at https://<name>.<tailnet>.ts.net, only
 *    after the edge answers as a DSH RC edge.
 * 4. Owner: completes /setup with a generated password saved to
 *    ~/.dsh-rc/owner-password.txt (owner-only). Never printed.
 * 5. Plugin: installs DSH RC into DeepSeek Harness pointed at the local edge
 *    (scripts/join-edge.mjs), which restarts DeepSeek Harness.
 *
 * Lines starting "ACTION NEEDED:" are the only human steps; the script waits
 * for them and continues by itself.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const tag = valueOf('--tag') ?? process.env.DSHRC_TAG ?? '';
const tsHostname = (valueOf('--hostname') ?? process.env.DSHRC_TS_HOSTNAME ?? 'dsh-rc').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'dsh-rc';
const state = join(homedir(), '.dsh-rc');
const tsDir = join(state, 'tailscale');
const edgeData = join(state, 'edge');
const edgeApp = join(state, 'edge-app');
// Test-only overrides (honoured only with DSHRC_TEST=1) let a sandbox run this without touching the real host.
const testing = process.env.DSHRC_TEST === '1';
const env = testing ? process.env : {};
const OS = env.DSHRC_TEST_PLATFORM ?? platform(); // darwin | linux | win32
const agents = env.DSHRC_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
const units = env.DSHRC_UNITS_DIR ?? join(homedir(), '.config', 'systemd', 'user');
const launchctl = env.DSHRC_LAUNCHCTL ?? 'launchctl';
const systemctl = env.DSHRC_SYSTEMCTL ?? 'systemctl';
const PORT = env.DSHRC_EDGE_PORT ?? '8787';
const LOCAL_EDGE = `http://127.0.0.1:${PORT}`;
const marker = join(state, 'host.json');
const WAIT_MS = 15 * 60_000;
// Windows: a per-user Run entry (no admin rights needed) starts the edge at every sign-in.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'DSH RC Edge';
// Windows uses Tailscale's own system service and default socket; macOS and Linux run a private user daemon.
const sock = OS === 'win32' ? undefined : join(tsDir, 'tailscaled.sock');
const computer = OS === 'darwin' ? 'Mac' : 'computer';

const log = (m) => process.stdout.write(`[dsh-rc host] ${m}\n`);
const fail = (m) => { process.stderr.write(`[dsh-rc host] ${m}\n`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, windowsHide: true, ...opts });
const tryRun = (cmd, args, opts) => { try { return run(cmd, args, opts); } catch { return undefined; } };
// Any unexpected failure ends with one plain line the agent can act on, not a stack trace.
const unexpected = (error) => fail(`stopped: ${String(error?.message ?? error).split('\n')[0]}. Fix the cause and run the setup command again.`);
process.on('uncaughtException', unexpected);
process.on('unhandledRejection', unexpected);

if (!['darwin', 'linux', 'win32'].includes(OS)) fail(`ACTION NEEDED: this system (${OS}) cannot be a host. Use a Mac, Windows or Linux computer.`);
if (tag !== '' && !/^v\d+\.\d+\.\d+$/.test(tag)) fail(`not a release tag: ${tag}`);
if (!/^\d{2,5}$/.test(PORT)) fail(`not a port: ${PORT}`);
// Paths end up inside service definitions; refuse characters that would need quoting there.
// Backslashes are Windows path separators; elsewhere they would act as escapes in a service file.
const unsafePath = OS === 'win32' ? /["'`$%\n]/ : /["'`$%\\\n]/;
for (const p of [homedir(), process.execPath, repo]) if (unsafePath.test(p)) fail(`ACTION NEEDED: the path ${p} contains a quote, $, %, backslash or backtick. Use a plain folder name and run again.`);

/** An edge service from another setup (for example a development copy) is never taken over. */
function existingEdgeService() {
  if (OS === 'darwin') return existsSync(join(agents, 'com.dshrc.edge.plist'));
  if (OS === 'linux') return existsSync(join(units, 'dsh-rc-edge.service')) || existsSync(join(state, 'dsh-rc-edge.sh'));
  return tryRun('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE]) !== undefined;
}
if (existingEdgeService() && !existsSync(marker) && process.env.DSHRC_FORCE !== '1') {
  fail(`ACTION NEEDED: this ${computer} already runs a DSH RC edge that was set up another way. It was left untouched. To replace it, run the setup command again with DSHRC_FORCE=1 set.`);
}
mkdirSync(state, { recursive: true, mode: 0o700 });
// Claim the host now, so a retry after a partial failure is recognised as ours.
if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify({ stage: 'started', repo, tag, at: Date.now() })}\n`, { mode: 0o600 });
mkdirSync(tsDir, { recursive: true, mode: 0o700 });

/* ------------------------------ 1. Tailscale ------------------------------ */

const firstExisting = (paths) => paths.find((p) => p !== undefined && existsSync(p));
const onPath = (name) => (process.env.PATH ?? '').split(delimiter).map((d) => join(d, name)).find((p) => existsSync(p));

async function ensureTailscale() {
  if (env.DSHRC_TAILSCALE !== undefined) return { cli: env.DSHRC_TAILSCALE, daemon: env.DSHRC_TAILSCALED };
  if (OS === 'darwin') {
    const find = (n) => firstExisting([`/opt/homebrew/bin/${n}`, `/usr/local/bin/${n}`, `/opt/homebrew/sbin/${n}`, `/usr/local/sbin/${n}`]);
    if (find('tailscale') === undefined || find('tailscaled') === undefined) {
      const brew = find('brew');
      if (brew === undefined) fail('ACTION NEEDED: install Homebrew from https://brew.sh (one command in Terminal), then run the setup command again.');
      log('installing Tailscale with Homebrew');
      run(brew, ['install', 'tailscale'], { stdio: 'inherit', timeout: 15 * 60_000 });
    }
    const cli = find('tailscale'); const daemon = find('tailscaled');
    if (cli === undefined || daemon === undefined) fail('Tailscale did not install; run the setup command again');
    return { cli, daemon };
  }
  if (OS === 'linux') {
    const bin = join(tsDir, 'bin');
    if (!existsSync(join(bin, 'tailscaled'))) await downloadTailscaleLinux(bin);
    return { cli: join(bin, 'tailscale'), daemon: join(bin, 'tailscaled') };
  }
  // Windows: the official package runs Tailscale as a system service.
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const winCli = () => firstExisting([join(programFiles, 'Tailscale', 'tailscale.exe'), onPath('tailscale.exe')]);
  if (winCli() === undefined) {
    if (onPath('winget.exe') === undefined) fail('ACTION NEEDED: install Tailscale from https://tailscale.com/download/windows, then run the setup command again.');
    log('ACTION NEEDED: installing Tailscale; approve the Windows prompt (Yes) if one appears. This script waits and continues by itself.');
    tryRun('winget.exe', ['install', '--id', 'Tailscale.Tailscale', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { stdio: 'inherit', timeout: 15 * 60_000 });
    for (let i = 0; i < 30 && winCli() === undefined; i += 1) await sleep(2000);
  }
  const cli = winCli();
  if (cli === undefined) fail('ACTION NEEDED: Tailscale did not install. Install it from https://tailscale.com/download/windows, then run the setup command again.');
  return { cli, daemon: undefined };
}

/** The official static Linux build into ~/.dsh-rc/tailscale/bin, checked against its published SHA-256. */
async function downloadTailscaleLinux(bin) {
  const archName = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch()];
  if (archName === undefined) fail(`ACTION NEEDED: no Tailscale build for this CPU (${arch()}). Install Tailscale yourself, then run again.`);
  const get = async (url, ms) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!response.ok) fail(`downloading ${url} failed (HTTP ${String(response.status)}); run the setup command again`);
    return response;
  };
  const index = await (await get('https://pkgs.tailscale.com/stable/?mode=json', 30_000)).json();
  const file = index?.Tarballs?.[archName];
  if (typeof file !== 'string' || !/^tailscale_[\d.]+_[a-z0-9]+\.tgz$/.test(file)) fail('could not read the Tailscale download list; run the setup command again');
  log(`downloading ${file}`);
  const [tgz, sum] = await Promise.all([
    get(`https://pkgs.tailscale.com/stable/${file}`, 300_000).then((r) => r.arrayBuffer()),
    get(`https://pkgs.tailscale.com/stable/${file}.sha256`, 30_000).then((r) => r.text()),
  ]);
  const got = createHash('sha256').update(Buffer.from(tgz)).digest('hex');
  if (got !== sum.trim().split(/\s+/)[0]) fail('the Tailscale download did not match its checksum; run the setup command again');
  mkdirSync(bin, { recursive: true });
  const archive = join(tsDir, file);
  writeFileSync(archive, Buffer.from(tgz));
  run('tar', ['-xzf', archive, '-C', bin, '--strip-components=1']);
  chmodSync(join(bin, 'tailscale'), 0o755);
  chmodSync(join(bin, 'tailscaled'), 0o755);
}

/** Keep the private Tailscale daemon running (macOS launchd, Linux systemd --user or a background loop). */
function ensureDaemon(daemon) {
  if (OS === 'win32') return;
  const daemonArgs = ['--tun=userspace-networking', `--state=${join(tsDir, 'tailscaled.state')}`, `--socket=${sock}`, '--port=0'];
  if (OS === 'darwin') {
    const plist = join(agents, 'com.dshrc.tailscaled.plist');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshrc.tailscaled</string>
  <key>ProgramArguments</key><array>
    <string>${daemon}</string>
${daemonArgs.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(tsDir, 'tailscaled.log')}</string>
  <key>StandardErrorPath</key><string>${join(tsDir, 'tailscaled.log')}</string>
</dict></plist>
`;
    mkdirSync(agents, { recursive: true });
    if (!existsSync(plist) || readFileSync(plist, 'utf8') !== xml) {
      writeFileSync(plist, xml);
      const uid = String(process.getuid?.() ?? '');
      tryRun(launchctl, ['bootout', `gui/${uid}`, plist]);
      run(launchctl, ['bootstrap', `gui/${uid}`, plist]);
      log('Tailscale daemon started');
    }
    return;
  }
  userService('dsh-rc-tailscaled', [daemon, ...daemonArgs].map((x) => `"${x}"`).join(' '), join(tsDir, 'tailscaled.log'), 'DSH RC Tailscale (userspace)');
}

/**
 * Linux: a systemd user service when available (restarted on failure, started at login,
 * and at boot when lingering is allowed); otherwise a background restart loop plus @reboot cron.
 */
function userService(name, command, logFile, description, restart = false) {
  const unit = `[Unit]
Description=${description}
After=network-online.target

[Service]
ExecStart=/bin/sh -c 'exec ${command} >> "${logFile}" 2>&1'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  const unitPath = join(units, `${name}.service`);
  const systemd = tryRun(systemctl, ['--user', 'show-environment']) !== undefined;
  if (systemd) {
    mkdirSync(units, { recursive: true });
    const changed = !existsSync(unitPath) || readFileSync(unitPath, 'utf8') !== unit;
    if (changed) writeFileSync(unitPath, unit);
    run(systemctl, ['--user', 'daemon-reload']);
    run(systemctl, ['--user', 'enable', '--now', `${name}.service`]);
    if (changed || restart) tryRun(systemctl, ['--user', 'restart', `${name}.service`]);
    // Keep user services running without a login session (allowed for your own user on most systems).
    if (tryRun('loginctl', ['enable-linger']) === undefined) log('note: this computer only lets the service run while you are signed in (loginctl enable-linger needs an administrator)');
    log(`${description} running as a user service`);
    return;
  }
  const loop = join(state, `${name}.sh`);
  writeFileSync(loop, `#!/bin/sh\n# Restart loop for ${description} (no systemd user session on this computer).\nwhile true; do ${command} >> "${logFile}" 2>&1; sleep 5; done\n`, { mode: 0o700 });
  if (tryRun('pgrep', ['-f', loop]) === undefined) spawn('/bin/sh', [loop], { detached: true, stdio: 'ignore' }).unref();
  // Stop only the running program (its command line names it); the loop starts the new code in 5 seconds.
  else if (restart) tryRun('pkill', ['-f', name === 'dsh-rc-edge' ? join(edgeApp, 'main.cjs') : join(tsDir, 'bin', 'tailscaled')]);
  const cron = tryRun('crontab', ['-l']) ?? '';
  if (!cron.includes(loop)) {
    try {
      execFileSync('crontab', ['-'], { input: `${cron.trimEnd()}\n@reboot /bin/sh ${loop}\n`.replace(/^\n/, ''), stdio: ['pipe', 'ignore', 'pipe'], timeout: 30_000 });
    } catch {
      log('note: could not add the start-at-boot entry (crontab); the service runs now but must be started again after a reboot');
    }
  }
  log(`${description} running in the background (restarts at boot via cron)`);
}

const { cli: tailscaleBin, daemon: tailscaled } = await ensureTailscale();
ensureDaemon(tailscaled);
const tsArgs = (args) => (sock === undefined ? args : [`--socket=${sock}`, ...args]);
const ts = (args, opts) => run(tailscaleBin, tsArgs(args), opts);
const tsStatus = () => { try { return JSON.parse(ts(['status', '--json'])); } catch { return undefined; } };
for (let i = 0; i < 30 && tsStatus() === undefined; i += 1) await sleep(1000);
if (tsStatus() === undefined) fail('the Tailscale daemon did not start; run the setup command again');

/** Run a Tailscale command that may print a link for the person; relay it and wait. */
async function withApproval(args, done, what) {
  if (await done()) return;
  const child = spawn(tailscaleBin, tsArgs(args), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  child.on('error', () => { exited = true; });
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    if (await done()) { child.kill(); return; }
    // Tailscale gave up without a link (policy, certificates off, ...): say why now, not in 15 minutes.
    if (exited) {
      await sleep(3000);
      if (await done()) return;
      if (OS === 'win32' && /access is denied|not the owner|operator/i.test(output)) fail(`ACTION NEEDED: ${what} was refused because another Windows user controls Tailscale on this computer. Sign in to Tailscale from this Windows account (Tailscale icon by the clock), then run the setup command again.`);
      fail(`${what} failed: ${output.trim().split('\n').slice(-3).join(' ') || 'no output'}`);
    }
    await sleep(3000);
  }
  child.kill();
  fail(`${what} was not approved within 15 minutes; run the setup command again`);
}

await withApproval(['up', `--hostname=${tsHostname}`], async () => tsStatus()?.BackendState === 'Running', `sign this ${computer} in to Tailscale (once)`);
const dnsName = String(tsStatus()?.Self?.DNSName ?? '').replace(/\.$/, '');
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(dnsName)) fail(`could not read this ${computer}'s Tailscale name; run the setup command again`);
const publicUrl = `https://${dnsName}`;

/* --------------------------------- 2. Edge -------------------------------- */

const node = process.execPath;
const npmName = OS === 'win32' ? 'npm.cmd' : 'npm';
// npm through node itself (npm-cli.js): no shell, so a path like C:\Program Files\nodejs works.
const npmCli = firstExisting([join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]);
const npmRun = (args, opts) => (npmCli !== undefined
  ? run(node, [npmCli, ...args], opts)
  : run(OS === 'win32' ? `"${npmName}"` : npmName, args, { ...opts, shell: OS === 'win32' }));
const npmEnv = { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}` };
delete npmEnv.ELECTRON_RUN_AS_NODE;
log('installing dependencies');
npmRun(['ci', '--no-audit', '--no-fund'], { cwd: repo, stdio: 'inherit', timeout: 20 * 60_000, env: npmEnv });

let edgeFingerprintNow;
const edgeArgs = ['--host', '127.0.0.1', '--port', PORT, '--data-dir', edgeData, '--public-url', publicUrl, '--trust-proxy', '--auto-approve-devices', '--log-level', 'info'];
if (env.DSHRC_INSTALL_EDGE !== undefined) {
  // Test seam: a sandbox edge on another port.
  run('sh', [env.DSHRC_INSTALL_EDGE], { stdio: 'inherit', timeout: 20 * 60_000, env: { ...process.env, DSHRC_NODE: node, DSHRC_PUBLIC_URL: publicUrl } });
} else if (OS === 'darwin') {
  run('sh', [join(repo, 'scripts', 'install-macos.sh')], {
    stdio: 'inherit', timeout: 20 * 60_000,
    env: { ...npmEnv, DSHRC_SKIP_TAILSCALED: '1', DSHRC_NODE: node, DSHRC_PUBLIC_URL: publicUrl, DSHRC_TAILSCALE: tailscaleBin, DSHRC_TAILSCALED: tailscaled },
  });
} else {
  npmRun(['run', 'build'], { cwd: repo, stdio: 'inherit', timeout: 20 * 60_000, env: npmEnv });
  npmRun(['run', 'build:bundle'], { cwd: repo, stdio: 'inherit', timeout: 20 * 60_000, env: npmEnv });
  mkdirSync(edgeApp, { recursive: true });
  mkdirSync(edgeData, { recursive: true, mode: 0o700 });
  copyFileSync(join(repo, 'build', 'edge', 'main.cjs'), join(edgeApp, 'main.cjs'));
  // A re-run or update restarts a running edge only when its code or settings changed.
  const fingerprint = createHash('sha256').update(readFileSync(join(edgeApp, 'main.cjs'))).update(JSON.stringify([node, edgeArgs])).digest('hex');
  let previous;
  try { previous = JSON.parse(readFileSync(marker, 'utf8')).edgeFingerprint; } catch { previous = undefined; }
  // Any earlier run of ours (even one that stopped early) may have left old code running.
  const restart = existsSync(marker) && previous !== fingerprint;
  edgeFingerprintNow = fingerprint;
  const edgeLogFile = join(edgeData, 'edge.log');
  if (OS === 'linux') {
    userService('dsh-rc-edge', `"${node}" "${join(edgeApp, 'main.cjs')}" ${edgeArgs.map((a) => `"${a}"`).join(' ')}`, edgeLogFile, 'DSH RC edge', restart);
  } else {
    // Windows: a hidden restart loop, started now and at every sign-in from the per-user Run key.
    const cmd = join(state, 'run-edge.cmd');
    const quoted = edgeArgs.map((a) => `"${a}"`).join(' ');
    writeFileSync(cmd, `@echo off\r\n:loop\r\n"${node}" "${join(edgeApp, 'main.cjs')}" ${quoted} >> "${edgeLogFile}" 2>&1\r\ntimeout /t 5 /nobreak >nul\r\ngoto loop\r\n`);
    const vbs = join(state, 'run-edge.vbs');
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${cmd}""", 0, False\r\n`);
    run('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f']);
    // Is the loop already running? (its cmd window is hidden; find it by command line)
    const ps = (script) => tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]) ?? '';
    // Unknown (PowerShell unavailable) counts as not running: a second loop is harmless, its node exits on the busy port.
    const count = Number.parseInt(ps("@(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*run-edge.cmd*' }).Count"), 10);
    const loopAlive = Number.isFinite(count) && count > 0;
    if (!loopAlive) {
      spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (restart) {
      // Stop only the edge's node; the loop starts the new code within 5 seconds.
      ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*edge-app*main.cjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
    }
    log('DSH RC edge running (starts at every sign-in)');
  }
}

const health = async () => { try { return await (await fetch(`${LOCAL_EDGE}/healthz`, { signal: AbortSignal.timeout(3000) })).json(); } catch { return undefined; } };
let h;
for (let i = 0; i < 90 && (h = await health()) === undefined; i += 1) await sleep(1000);
if (h === undefined) fail(`the edge did not start; see ${join(edgeData, 'edge.log')} and run the setup command again`);
// Publish only a DSH RC edge: something else on this port must never reach the internet.
if (h.status !== 'ok' || typeof h.setupComplete !== 'boolean') fail(`port ${PORT} answers, but not as a DSH RC edge; nothing was published`);

/* -------------------------------- 3. Funnel ------------------------------- */

const funnelOn = async () => { try { return new RegExp(`127\\.0\\.0\\.1:${PORT}\\b|localhost:${PORT}\\b`).test(ts(['funnel', 'status'])); } catch { return false; } };
await withApproval(['funnel', '--bg', PORT], funnelOn, `turn on Tailscale Funnel for this ${computer} (once)`);
log(`public address ${publicUrl}`);

/* ------------------------------ 4. Owner account -------------------------- */

const passwordFile = join(state, 'owner-password.txt');
if (h.setupComplete !== true) {
  const edgeLog = env.DSHRC_EDGE_LOG ?? join(edgeData, 'edge.log');
  const latestCode = () => (existsSync(edgeLog) ? readFileSync(edgeLog, 'utf8').split('\n') : []).map((l) => /DSH RC setup code: (\S+)/.exec(l)?.[1]).filter(Boolean).pop();
  const password = existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8').trim() : randomBytes(18).toString('base64url');
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  chmodSync(passwordFile, 0o600);
  // Windows ignores file modes: limit the password file to this user.
  if (OS === 'win32') {
    const account = process.env.USERDOMAIN !== undefined ? `${process.env.USERDOMAIN}\\${process.env.USERNAME ?? ''}` : (process.env.USERNAME ?? '');
    if (tryRun('icacls.exe', [passwordFile, '/inheritance:r', '/grant:r', `${account}:F`]) === undefined) log('note: could not restrict the password file to your account; it is still inside your private profile folder');
  }
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

/* --------------------------------- 5. Plugin ------------------------------ */

const joinArgs = [join(repo, 'scripts', 'join-edge.mjs'), LOCAL_EDGE];
if (tag !== '') joinArgs.push('--tag', tag);
try {
  execFileSync(node, joinArgs, { stdio: 'inherit', timeout: 20 * 60_000, windowsHide: true });
} catch {
  fail('installing the plugin failed (see above); fix the cause and run the setup command again');
}
writeFileSync(marker, `${JSON.stringify({ stage: 'ready', publicUrl, repo, tag, edgeFingerprint: edgeFingerprintNow, at: Date.now() })}\n`, { mode: 0o600 });
log(`HOST READY: ${publicUrl}`);
log('Other computers: in DeepSeek Harness here, open Remote Control, press Build Setup Prompt, and paste that prompt on each one.');
