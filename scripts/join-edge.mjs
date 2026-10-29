#!/usr/bin/env node
/**
 * Cross-platform DSH RC host join/update.
 *
 *   node scripts/join-edge.mjs <edge-url> [device-name] [--profile <name>] [--no-restart]
 *
 * Does everything the copy-paste prompt needs: updates the checkout, builds,
 * installs the plugin into the running profile, writes the cordis patch, links
 * the package, and schedules a DeepSeek Harness restart. No owner password,
 * invite token or device secret is used.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const edge = (positional[0] ?? process.env.DSHRC_EDGE_URL ?? '').replace(/\/+$/, '');
const deviceName = positional[1] ?? process.env.DSHRC_DEVICE_NAME ?? hostname();
const profileArg = valueOf('--profile') ?? process.env.DSHRC_PROFILE ?? '';
const restart = !argv.includes('--no-restart');

if (!/^https?:\/\//.test(edge)) fail(`usage: node scripts/join-edge.mjs <edge-url> [device-name] [--profile name] [--no-restart]`);
if (Number(process.versions.node.split('.')[0]) < 24) fail(`Node 24+ is required (found ${process.versions.node})`);

log(`repo ${repo}`);
gitUpdate();
build();
const profile = resolveProfile();
installProfile(profile);
writePatch(profile);
writeStatus();
if (restart) {
  scheduleRestart();
  log('installed; Harness restart scheduled');
} else {
  log('installed; restart skipped (--no-restart)');
}
log('The edge auto-approves this Harness; no dashboard approval is needed.');

function valueOf(flag) {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

function log(message) {
  process.stdout.write(`[dsh-rc join] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[dsh-rc join] ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
    shell: platform() === 'win32',
  });
}

function gitUpdate() {
  if (!existsSync(join(repo, '.git'))) {
    log('no .git checkout; keeping the downloaded source as-is');
    return;
  }
  try {
    run('git', ['fetch', '--tags', '--force', 'origin']);
    const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: repo, encoding: 'utf8' })
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const tag = tags[0];
    if (tag !== undefined && tag !== '') run('git', ['checkout', '-f', tag]);
  } catch (error) {
    log(`git update failed (${String(error.message)}); building the current checkout`);
  }
}

function build() {
  const npm = platform() === 'win32' ? 'npm.cmd' : 'npm';
  try {
    run(npm, ['ci']);
  } catch {
    log('npm ci failed; falling back to npm install');
    run(npm, ['install']);
  }
  run(npm, ['run', 'build']);
}

function resolveProfile() {
  if (profileArg !== '') return profileArg;
  const profiles = join(homedir(), '.dsh', 'profiles');
  if (existsSync(join(profiles, 'desktop', 'package.json'))) return 'desktop';
  if (existsSync(join(profiles, 'web', 'package.json'))) return 'web';
  try {
    const first = readdirSync(profiles).find((name) => existsSync(join(profiles, name, 'package.json')));
    if (first !== undefined) return first;
  } catch { /* fall through */ }
  return 'desktop';
}

function installProfile(profile) {
  const profileDir = join(homedir(), '.dsh', 'profiles', profile);
  const manifestPath = join(profileDir, 'package.json');
  if (!existsSync(manifestPath)) fail(`profile ${profile} not found at ${profileDir}`);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = manifest.dependencies ?? {};
  manifest.dependencies['@dsh-rc/plugin'] = `link:${join(repo, 'packages', 'plugin')}`;
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  const bundles = manifest.dsh.profile.bundles ?? [];
  if (!bundles.includes('@dsh-rc/plugin')) bundles.push('@dsh-rc/plugin');
  manifest.dsh.profile.bundles = bundles;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const target = join(profileDir, 'node_modules', '@dsh-rc', 'plugin');
  mkdirSync(dirname(target), { recursive: true });
  try {
    if (lstatSync(target) !== undefined) rmSync(target, { recursive: true, force: true });
  } catch { /* absent */ }
  symlinkSync(join(repo, 'packages', 'plugin'), target, platform() === 'win32' ? 'junction' : 'dir');
  log(`profile ${profile}: linked plugin and bundle`);
}

function writePatch(profile) {
  const patchPath = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');
  let existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  existing = existing.replace(/^[ \t]*\[\][ \t]*\r?\n?/m, '');
  const entry = [
    '- id: dsh-rc',
    '  config:',
    '    enabled: true',
    `    edgeUrl: "${edge}"`,
    `    deviceName: "${deviceName.replace(/"/g, '')}"`,
    '    autoStart: true',
    `    agentEntry: "${join(repo, 'apps', 'agent', 'dist', 'main.js')}"`,
    '    logLevel: info',
    '',
  ].join('\n');
  const block = /^- id: dsh-rc\r?\n(?:[ \t].*\r?\n)*/m;
  if (block.test(existing)) {
    existing = existing.replace(block, entry);
  } else {
    existing = `${existing.trimEnd()}\n\n${entry}`;
  }
  writeFileSync(patchPath, `${existing.trimEnd()}\n`);
  log(`patch: ${patchPath}`);
}

function writeStatus() {
  mkdirSync(join(homedir(), '.dsh-rc'), { recursive: true });
  writeFileSync(join(homedir(), '.dsh-rc', 'join-status.json'), `${JSON.stringify({ ok: true, edge, deviceName, at: Date.now() })}\n`);
}

function scheduleRestart() {
  if (platform() === 'darwin') {
    spawn('/bin/sh', ['-c', 'sleep 5; osascript -e "tell application \\"DeepSeek Harness\\" to quit" >/dev/null 2>&1; sleep 8; pkill -TERM -f "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" 2>/dev/null; sleep 3; open -a "DeepSeek Harness"'], { detached: true, stdio: 'ignore' }).unref();
    log('DeepSeek Harness restart scheduled (macOS)');
    return;
  }
  if (platform() === 'win32') {
    const ps = [
      'Start-Sleep -Seconds 2;',
      "$p = Get-Process | Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' } | Select-Object -First 1;",
      'if ($p) { $exe = $p.Path; Stop-Process -Id $p.Id -Force; Start-Sleep -Seconds 3; if ($exe) { Start-Process $exe } }',
    ].join(' ');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('DeepSeek Harness restart scheduled (Windows)');
    return;
  }
  log('no automatic restart on this platform; start the Harness profile again');
}