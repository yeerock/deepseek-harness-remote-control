#!/usr/bin/env node
/**
 * Cross-platform DSH RC self-update (macOS, Windows, Linux).
 *
 *   node scripts/self-update.mjs --tag vX.Y.Z [--force]
 *
 * Started detached by the host plugin when GitHub reports a newer release.
 * It never restarts DeepSeek Harness itself: the host does that once no
 * session is running. Progress and the outcome go to
 * ~/.dsh-rc/update-status.json, which the host polls.
 *
 * Safety:
 * - one run at a time (~/.dsh-rc/update.lock, stale after 30 minutes);
 * - only release tags (vX.Y.Z) are accepted;
 * - a development checkout (HEAD on a branch, worktrees included) is never
 *   touched unless --force;
 * - local edits are stashed, never discarded, and the status says so;
 * - dependencies are updated in place (`npm install`), so packages the running
 *   plugin uses stay where they are; `npm ci` is only the fallback;
 * - a failed build rolls back to the previous commit and rebuilds it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const tag = valueOf('--tag') ?? process.env.DSHRC_UPDATE_TAG ?? '';
const force = argv.includes('--force');
const stateDir = join(homedir(), '.dsh-rc');
const statusPath = join(stateDir, 'update-status.json');
const lockPath = join(stateDir, 'update.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;

mkdirSync(stateDir, { recursive: true });

if (!takeLock()) {
  // The run holding the lock writes the final status; this only says it is still going.
  log('another update is already running');
  writeStatus({ state: 'busy', to: tag, message: 'Another update is already running.' });
  process.exit(0);
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) finish('error', `not a release tag: ${tag || '(none)'}`, 2);
if (Number(process.versions.node.split('.')[0]) < 24) finish('error', `Node 24 or newer is required (found ${process.versions.node})`, 1);
if (!existsSync(join(repo, '.git'))) finish('skipped', 'This copy was not installed with git. Paste the setup prompt once to switch it to automatic updates.', 0);
if (!force && isOnBranch()) finish('skipped', 'Development copy (on a git branch); updates come from git, not automatically.', 0);

const from = currentVersion();
let previous = '';
let stashed = false;
try {
  // percent drives the Update pill; the stages are weighted by how long they usually take.
  const step = (percent) => writeStatus({ state: 'installing', from, to: tag, percent });
  step(5);
  previous = git(['rev-parse', 'HEAD']).trim();
  if (git(['status', '--porcelain']).trim() !== '') {
    log('local changes found; stashing them (git stash list to recover)');
    git(['stash', 'push', '--include-untracked', '-m', `dsh-rc auto-update ${new Date().toISOString()}`]);
    stashed = true;
  }
  git(['fetch', '--tags', '--force', 'origin']);
  step(20);
  git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
  git(['checkout', '-f', `refs/tags/${tag}`]);
  step(30);
  build(step);
  const installed = currentVersion();
  if (`v${installed}` !== tag) throw new Error(`built version ${installed} does not match ${tag}`);
  if (!existsSync(join(repo, 'packages', 'plugin', 'dist', 'index.js'))) throw new Error('plugin build output is missing');
  refreshMacEdge();
  writeStatus({
    state: 'installed', ok: true, from, to: tag, stashed,
    message: stashed
      ? `Update installed. Local edits in ${repo} were set aside with git stash (git stash list shows them).`
      : 'Update installed; DeepSeek Harness restarts to load it.',
  });
  log(`installed ${tag}`);
} catch (error) {
  const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
  log(`update failed: ${reason}`);
  let rolledBack = false;
  if (previous !== '') {
    try {
      git(['checkout', '-f', previous]);
      build();
      rolledBack = true;
    } catch (rollbackError) {
      log(`rollback failed: ${rollbackError instanceof Error ? rollbackError.message.split('\n')[0] : String(rollbackError)}`);
    }
  }
  writeStatus({ state: 'error', ok: false, from, to: tag, rolledBack, message: `Update to ${tag} failed: ${reason}${rolledBack ? ' (kept the current version)' : ''}` });
  releaseLock();
  process.exit(1);
}
releaseLock();

function valueOf(flag) {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

function log(message) {
  process.stdout.write(`[dsh-rc update] ${new Date().toISOString()} ${message}\n`);
}

function writeStatus(fields) {
  const body = `${JSON.stringify({ ...fields, at: Date.now(), pid: process.pid })}\n`;
  const temp = `${statusPath}.${String(process.pid)}.tmp`;
  writeFileSync(temp, body, { mode: 0o600 });
  renameSync(temp, statusPath);
}

function finish(state, message, code) {
  log(message);
  writeStatus({ state, ok: state !== 'error', to: tag, message });
  releaseLock();
  process.exit(code);
}

function takeLock() {
  try {
    writeFileSync(lockPath, `${String(process.pid)} ${String(Date.now())}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, `${String(process.pid)} ${String(Date.now())}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
}

function releaseLock() {
  try {
    const owner = readFileSync(lockPath, 'utf8').split(' ')[0];
    if (owner === String(process.pid)) rmSync(lockPath, { force: true });
  } catch { /* already gone */ }
}

function git(args) {
  log(`git ${args.join(' ')}`);
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/** HEAD on a branch means someone develops here. Works for worktrees too, where .git is a file. */
function isOnBranch() {
  try {
    execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function currentVersion() {
  try {
    return String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

function npm(args) {
  log(`npm ${args.join(' ')}`);
  // The node running this script first, then the portable runtime the setup prompt may have installed.
  const dirs = [dirname(process.execPath), join(stateDir, 'node'), join(stateDir, 'node', 'bin'), process.env.PATH ?? ''];
  const env = { ...process.env, PATH: dirs.join(platform() === 'win32' ? ';' : ':') };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(platform() === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: repo, stdio: 'inherit', env, shell: platform() === 'win32', windowsHide: true });
}

function build(step = () => undefined) {
  try {
    npm(['install', '--no-audit', '--no-fund']);
  } catch {
    log('npm install failed; retrying with a clean npm ci');
    npm(['ci', '--no-audit', '--no-fund']);
  }
  step(65);
  try {
    npm(['run', 'build']);
  } catch {
    // Windows can briefly lock a file the live plugin just read; one retry clears most of those.
    log('build failed; retrying once');
    npm(['run', 'build']);
  }
  step(95);
  // npm may rewrite the lockfile (platform-specific optional packages); keep the tree clean
  // so the next update does not mistake that for local edits.
  try {
    git(['checkout', '--', 'package-lock.json']);
  } catch { /* nothing to restore */ }
}

/** The macOS owner machine also runs the edge from a copied bundle. */
function refreshMacEdge() {
  if (platform() !== 'darwin') return;
  const target = join(homedir(), 'Library', 'Application Support', 'dsh-rc', 'edge', 'main.cjs');
  if (!existsSync(target)) return;
  try {
    npm(['run', 'build:bundle']);
    copyFileSync(join(repo, 'build', 'edge', 'main.cjs'), target);
    execFileSync('launchctl', ['kickstart', '-k', `gui/${String(process.getuid?.() ?? '')}/com.dshrc.edge`], { stdio: 'ignore' });
  } catch (error) {
    log(`edge refresh skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}
