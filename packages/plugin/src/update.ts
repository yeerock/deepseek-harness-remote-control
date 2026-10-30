/**
 * Auto-update coordinator for the host plugin.
 *
 * 1. Check: two minutes after start, then hourly (and on demand), read the
 *    public GitHub "latest release" feed.
 * 2. Install: when a newer vX.Y.Z exists and no session is running (or at
 *    once when the user presses Check for Updates), run
 *    `scripts/self-update.mjs` detached with a real Node 24. The script is
 *    cross-platform, locked, refuses development checkouts, and rolls back on
 *    a failed build. It reports through ~/.dsh-rc/update-status.json, which
 *    this class polls. A release that failed is not retried automatically.
 * 3. Restart: a running Harness keeps the old plugin in memory, so once the
 *    update is installed DeepSeek Harness is restarted, but only while no
 *    session is running, and at most twice per release so a bad restart can
 *    never loop.
 *
 * DSHRC_AUTO_UPDATE=0 turns checking off; DSHRC_AUTO_RESTART=0 keeps the
 * install automatic but leaves the restart to the Restart to Update button.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const UPDATE_REPO = 'yeerock/deepseek-harness-remote-control';
export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
const POLL_MS = 5_000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const IDLE_CHECK_MS = 60_000;
const MAX_RESTARTS_PER_RELEASE = 2;
/**
 * A restart that has not happened by now failed (this process is still the
 * old one). Without this the state stayed `restarting` forever and blocked
 * every later update check, so a computer froze on an old version.
 */
const RESTART_TIMEOUT_MS = 3 * 60_000;

export type UpdateState =
  | 'idle' // up to date
  | 'checking'
  | 'available' // newer release found, installs when no session is running
  | 'installing'
  | 'ready' // installed, waiting for a restart
  | 'restarting'
  | 'development' // a git branch checkout: updates come from git
  | 'error';

export interface UpdateSnapshot {
  state: UpdateState;
  latest?: string;
  message?: string;
  checkedAt?: number;
  /** Install progress 0-100 while installing. */
  percent?: number;
}

export function versionParts(value: string): number[] {
  const clean = value.trim().replace(/^v/i, '').split('-')[0] ?? '';
  return clean.split('.').map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
}

/** True when `latest` is a strictly newer semver than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/** True when the checkout's HEAD is a branch, i.e. someone develops in it (worktrees included). */
export function isDevelopmentCheckout(repoRoot: string): boolean {
  if (!existsSync(join(repoRoot, '.git'))) return false;
  try {
    execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: repoRoot, stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

interface InstallerStatus {
  state?: string;
  percent?: number;
  stashed?: boolean;
  to?: string;
  at?: number;
  message?: string;
}

export interface UpdateManagerOptions {
  repoRoot: string;
  currentVersion: string;
  /** Resolves true when no session on this Harness is working. */
  isIdle?: () => Promise<boolean>;
  stateDir?: string;
  fetchImpl?: typeof fetch;
  /** Starts the installer; tests replace it. */
  spawnInstaller?: (tag: string) => void;
  /** Restarts DeepSeek Harness; tests replace it. */
  restartHarness?: (logFile?: string) => boolean;
  /** Clock; tests replace it. */
  now?: () => number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

export class UpdateManager {
  private readonly options: UpdateManagerOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly stateDir: string;
  private snapshot: UpdateSnapshot = { state: 'idle' };
  private timers: NodeJS.Timeout[] = [];
  private poller: NodeJS.Timeout | undefined;
  private started = false;
  private installStartedAt = 0;
  private restartStartedAt = 0;
  /** A release whose install failed; only a manual check retries it. */
  private failedVersion: string | undefined;

  constructor(options: UpdateManagerOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.stateDir = options.stateDir ?? join(homedir(), '.dsh-rc');
  }

  private get statusPath(): string {
    return join(this.stateDir, 'update-status.json');
  }

  private get restartsPath(): string {
    return join(this.stateDir, 'update-restarts.json');
  }

  start(): void {
    if (this.started || process.env['DSHRC_AUTO_UPDATE'] === '0') return;
    this.started = true;
    if (isDevelopmentCheckout(this.options.repoRoot)) {
      this.snapshot = { state: 'development', message: 'Development copy: updates come from git.' };
      return;
    }
    // An update installed before the last restart that never loaded.
    const last = this.readInstallerStatus();
    if (last?.state === 'installed' && typeof last.to === 'string' && isNewerVersion(last.to, this.options.currentVersion)) {
      this.markReady(last.to.replace(/^v/i, ''));
    }
    if (last?.state === 'error' && typeof last.to === 'string') this.failedVersion = last.to.replace(/^v/i, '');
    this.later(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.every(() => void this.check(), UPDATE_INTERVAL_MS);
    this.every(() => void this.tick(), IDLE_CHECK_MS);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.poller !== undefined) clearInterval(this.poller);
    this.poller = undefined;
  }

  getSnapshot(): UpdateSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Read the release feed. `manual` (the Check for Updates button) installs
   * at once and retries a release that failed before; the hourly check waits
   * for an idle moment and skips a failed release.
   */
  async check(manual = false): Promise<UpdateSnapshot> {
    this.expireRestart();
    const busy: UpdateState[] = ['checking', 'installing', 'restarting', 'development'];
    if (busy.includes(this.snapshot.state)) return this.getSnapshot();
    if (isDevelopmentCheckout(this.options.repoRoot)) {
      this.snapshot = { state: 'development', message: 'Development copy: updates come from git.' };
      return this.getSnapshot();
    }
    const previous = this.snapshot;
    this.snapshot = { ...previous, state: 'checking' };
    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
        { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-rc-plugin' }, signal: AbortSignal.timeout(10_000) },
      );
      if (response.status === 403 || response.status === 429) throw new Error('GitHub is limiting update checks right now; trying again within the hour.');
      if (!response.ok) throw new Error(`GitHub releases returned HTTP ${String(response.status)}`);
      const body = (await response.json()) as { tag_name?: unknown };
      const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : '';
      if (!RELEASE_VERSION.test(latest)) throw new Error('GitHub release has no usable version tag');
      const checkedAt = Date.now();
      if (!isNewerVersion(latest, this.options.currentVersion)) {
        this.snapshot = { state: 'idle', latest, checkedAt };
        return this.getSnapshot();
      }
      // An installed update waiting for its restart stays, unless an even newer one is out.
      if (previous.state === 'ready' && previous.latest !== undefined && !isNewerVersion(latest, previous.latest)) {
        this.snapshot = { ...previous, checkedAt };
        return this.getSnapshot();
      }
      if (!manual && latest === this.failedVersion) {
        this.snapshot = { state: 'error', latest, checkedAt, message: `Version ${latest} could not be installed earlier; press Check for Updates to try again.` };
        return this.getSnapshot();
      }
      if (manual) {
        this.install(latest, checkedAt);
      } else {
        this.snapshot = { state: 'available', latest, checkedAt, message: `Version ${latest} is available and installs as soon as no session is running.` };
        await this.tick();
      }
      return this.getSnapshot();
    } catch (error) {
      // A failed check never loses an update that is waiting or already installed.
      if (previous.state === 'ready' || previous.state === 'available') {
        this.snapshot = previous;
        return this.getSnapshot();
      }
      this.snapshot = {
        state: 'error',
        ...(previous.latest !== undefined ? { latest: previous.latest } : {}),
        checkedAt: Date.now(),
        message: error instanceof Error ? error.message : 'update check failed',
      };
      this.options.logger?.warn?.('dsh-rc update check failed');
      return this.getSnapshot();
    }
  }

  /**
   * Restart asked for by another computer: counts toward the per-release
   * cap, so repeated presses cannot force-restart a failing host forever.
   */
  restartForPeer(): UpdateSnapshot {
    if (this.snapshot.state !== 'ready') return this.getSnapshot();
    const latest = this.snapshot.latest ?? '';
    if (this.restartAttempts(latest) >= MAX_RESTARTS_PER_RELEASE) throw new Error('That computer already tried to restart twice for this version. Quit and reopen DeepSeek Harness on it.');
    this.doRestart(latest, false);
    return this.getSnapshot();
  }

  /** Restart now (the panel button). Ignores the idle rule; the user asked. */
  restartNow(): UpdateSnapshot {
    if (this.snapshot.state !== 'ready') return this.getSnapshot();
    this.doRestart(this.snapshot.latest ?? '', true);
    return this.getSnapshot();
  }

  private install(latest: string, checkedAt: number): void {
    if (this.snapshot.state === 'installing') return;
    if (this.poller !== undefined) clearInterval(this.poller);
    this.poller = undefined;
    const script = join(this.options.repoRoot, 'scripts', 'self-update.mjs');
    if (this.options.spawnInstaller === undefined && !existsSync(script)) {
      this.snapshot = { state: 'error', latest, checkedAt, message: 'The updater script is missing; paste the setup prompt once to repair this copy.' };
      return;
    }
    let spawnInstaller = this.options.spawnInstaller;
    if (spawnInstaller === undefined) {
      const node = updateNodeCommand();
      if (node === undefined) {
        this.snapshot = { state: 'error', latest, checkedAt, message: 'Node 24 was not found on this computer, so the update cannot be built. Paste the setup prompt once to install it.' };
        return;
      }
      spawnInstaller = (tag: string) => this.spawnScript(node, script, tag);
    }
    try {
      spawnInstaller(`v${latest}`);
      this.installStartedAt = Date.now();
      this.snapshot = { state: 'installing', latest, checkedAt, message: `Installing version ${latest} in the background.` };
      this.options.logger?.info?.(`dsh-rc auto-update to ${latest} started`);
      this.poller = setInterval(() => this.pollInstaller(latest), POLL_MS);
      this.poller.unref?.();
    } catch (error) {
      this.snapshot = { state: 'error', latest, checkedAt, message: error instanceof Error ? error.message : 'could not start the updater' };
    }
  }

  private spawnScript(node: { command: string; env: NodeJS.ProcessEnv }, script: string, tag: string): void {
    mkdirSync(this.stateDir, { recursive: true });
    const logFd = openSync(join(this.stateDir, 'update.log'), 'a', 0o600);
    try {
      const child = spawn(node.command, [script, '--tag', tag], {
        cwd: this.options.repoRoot,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env: node.env,
      });
      child.on('error', () => undefined);
      child.unref();
    } finally {
      closeSync(logFd);
    }
  }

  /** Called every few seconds while the installer runs. Exposed for tests. */
  pollInstaller(latest: string): void {
    const status = this.readInstallerStatus();
    const fresh = status !== undefined && status.to === `v${latest}` && (status.at ?? 0) >= this.installStartedAt;
    const settle = (snapshot: UpdateSnapshot): void => {
      if (this.poller !== undefined) clearInterval(this.poller);
      this.poller = undefined;
      this.snapshot = { ...snapshot, ...(this.snapshot.checkedAt !== undefined ? { checkedAt: this.snapshot.checkedAt } : {}) };
    };
    if (fresh && status.state === 'installed') {
      settle({ state: 'ready', latest });
      this.markReady(latest, status.message);
      return;
    }
    if (fresh && (status.state === 'error' || status.state === 'skipped')) {
      if (status.state === 'error') this.failedVersion = latest;
      settle({ state: status.state === 'skipped' ? 'development' : 'error', latest, message: status.message ?? 'The update did not finish.' });
      return;
    }
    // 'busy' (a run already holding the lock) and 'installing' keep polling until the final status.
    if (fresh && status.state === 'installing' && typeof status.percent === 'number' && this.snapshot.state === 'installing') {
      this.snapshot = { ...this.snapshot, percent: Math.max(0, Math.min(100, Math.round(status.percent))) };
    }
    if (Date.now() - this.installStartedAt > INSTALL_TIMEOUT_MS) {
      this.failedVersion = latest;
      settle({ state: 'error', latest, message: 'The update took too long and was abandoned; it will be tried again later.' });
    }
  }

  private markReady(latest: string, installerMessage?: string): void {
    const stashNote = installerMessage?.includes('git stash') === true ? ` ${installerMessage.replace(/^Update installed\. /, '')}` : '';
    this.snapshot = {
      ...this.snapshot,
      state: 'ready',
      latest,
      message: `Version ${latest} is installed. DeepSeek Harness restarts to load it as soon as no session is running.${stashNote}`,
    };
  }

  /** Called every minute: install a waiting release, or restart for an installed one, when idle. Exposed for tests. */
  async tick(): Promise<void> {
    this.expireRestart();
    if (this.snapshot.state === 'available') {
      const idle = await this.idle();
      // Re-check after the await: the hourly check may have started the install meanwhile.
      if (idle && this.snapshot.state === 'available') this.install(this.snapshot.latest ?? '', this.snapshot.checkedAt ?? Date.now());
      return;
    }
    await this.restartIfIdle();
  }

  private async idle(): Promise<boolean> {
    try {
      return (await this.options.isIdle?.()) ?? false;
    } catch {
      return false;
    }
  }

  async restartIfIdle(): Promise<void> {
    if (this.snapshot.state !== 'ready' || process.env['DSHRC_AUTO_RESTART'] === '0') return;
    const latest = this.snapshot.latest ?? '';
    if (this.restartAttempts(latest) >= MAX_RESTARTS_PER_RELEASE) {
      const reason = this.restartLogTail();
      this.snapshot = { ...this.snapshot, message: `Version ${latest} is installed. Press Restart to Update, or quit and reopen DeepSeek Harness, to load it.${reason === '' ? '' : ' The last restart attempt did not finish; details are in restart-helper.log.'}` };
      return;
    }
    if (await this.idle()) this.doRestart(latest, false);
  }

  /** A restart still pending after the timeout failed: go back to `ready` so it is retried (within the cap) or done by hand. */
  private expireRestart(): void {
    if (this.snapshot.state !== 'restarting') return;
    if (this.clock() - this.restartStartedAt < RESTART_TIMEOUT_MS) return;
    const latest = this.snapshot.latest ?? '';
    const reason = this.restartLogTail();
    this.snapshot = {
      ...this.snapshot,
      state: 'ready',
      message: `DeepSeek Harness did not restart to load version ${latest}. Press Restart to Update, or quit and reopen it.${reason === '' ? '' : ' Details are in restart-helper.log.'}`,
    };
    this.options.logger?.warn?.('dsh-rc restart did not happen; back to ready');
  }

  private clock(): number {
    return (this.options.now ?? Date.now)();
  }

  private get restartLogPath(): string {
    return join(this.stateDir, 'restart-helper.log');
  }

  /** Last line the restart helper wrote, for the panel; empty when there is none. */
  private restartLogTail(): string {
    try {
      const lines = readFileSync(this.restartLogPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
      return (lines[lines.length - 1] ?? '').slice(0, 200);
    } catch {
      return '';
    }
  }

  private doRestart(latest: string, manual: boolean): void {
    if (!manual) this.recordRestart(latest);
    const restarted = (this.options.restartHarness ?? scheduleHarnessRestart)(this.restartLogPath);
    if (restarted) {
      this.restartStartedAt = this.clock();
      this.snapshot = { ...this.snapshot, state: 'restarting', message: `Restarting DeepSeek Harness to load version ${latest}.` };
    } else {
      this.snapshot = { ...this.snapshot, message: `Version ${latest} is installed. Quit and reopen DeepSeek Harness to load it.` };
    }
  }

  private readInstallerStatus(): InstallerStatus | undefined {
    try {
      const value = JSON.parse(readFileSync(this.statusPath, 'utf8')) as unknown;
      return typeof value === 'object' && value !== null ? value as InstallerStatus : undefined;
    } catch {
      return undefined;
    }
  }

  private restartAttempts(latest: string): number {
    try {
      const value = JSON.parse(readFileSync(this.restartsPath, 'utf8')) as { version?: unknown; attempts?: unknown };
      return value.version === latest && typeof value.attempts === 'number' ? value.attempts : 0;
    } catch {
      return 0;
    }
  }

  private recordRestart(latest: string): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.restartsPath, `${JSON.stringify({ version: latest, attempts: this.restartAttempts(latest) + 1, at: Date.now() })}\n`, { mode: 0o600 });
    } catch { /* the cap is best effort */ }
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  private every(fn: () => void, ms: number): void {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    this.timers.push(timer);
  }
}

/**
 * A real Node 24+ for the installer (npm must be reachable): DSHRC_NODE,
 * `node` on PATH, or the portable runtime the setup prompt installs. The
 * Electron runtime is never used: it has no npm, so every build would fail.
 */
function updateNodeCommand(): { command: string; env: NodeJS.ProcessEnv } | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  const portable = join(homedir(), '.dsh-rc', 'node');
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [process.env['DSHRC_NODE'], 'node', join(portable, exe), join(portable, 'bin', exe)];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue;
    try {
      const version = execFileSync(candidate, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, env }).trim();
      if (Number(version.split('.')[0]) >= 24) return { command: candidate, env };
    } catch { /* try the next */ }
  }
  return undefined;
}

/**
 * Quit and reopen DeepSeek Harness from a detached helper. False when unsupported.
 * It asks the app to quit and waits up to 60 s for a clean exit: forcing it
 * earlier cut off its browser storage and broke the next start
 * ("desktop welcome: Web authentication failed").
 */
export function scheduleHarnessRestart(logFile?: string): boolean {
  try {
    if (process.platform === 'darwin') {
      const log = logFile === undefined ? '/dev/null' : `'${logFile.replace(/'/g, `'\\''`)}'`;
      spawn('/bin/sh', ['-c', `exec >>${log} 2>&1; echo "restart requested $(date)"; sleep 3; osascript -e "tell application \\"DeepSeek Harness\\" to quit" >/dev/null 2>&1; i=0; while pgrep -a -x "DeepSeek Harness" >/dev/null 2>&1 && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done; pkill -a -TERM -x "DeepSeek Harness" 2>/dev/null; sleep 3; open -a "DeepSeek Harness" && echo "reopened" || echo "could not reopen DeepSeek Harness"`], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    if (process.platform === 'win32') {
      if (logFile === undefined) return false;
      // The app's own executable is the fallback when Get-Process cannot read its path.
      const fallbackExe = /deepseek/i.test(process.execPath) ? process.execPath : '';
      const script = join(dirname(logFile), 'restart-helper.ps1');
      writeFileSync(script, windowsRestartScript(logFile, fallbackExe), { encoding: 'utf8', mode: 0o600 });
      // Started through WMI so the helper is not in DeepSeek Harness's process
      // tree: closing the app (taskkill /T) can no longer take the helper down
      // before it reopens the app, which left computers stuck on old versions.
      const launch = `$ok = $false; try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script.replace(/'/g, "''")}"' }; $ok = ($r.ReturnValue -eq 0) } catch { $ok = $false }; if (-not $ok) { Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${script.replace(/'/g, "''")}"') }`;
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launch], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

/** PowerShell for the Windows restart helper; writes each step to `logFile`. Exported for tests. */
export function windowsRestartScript(logFile: string, fallbackExe: string): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return [
    `$log = ${quote(logFile)}`,
    `$fallback = ${quote(fallbackExe)}`,
    "function Say($m) { Add-Content -Path $log -Value ((Get-Date -Format s) + ' ' + $m) }",
    "Say 'restart requested'",
    'Start-Sleep -Seconds 3',
    "$procs = @(Get-Process | Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' })",
    '$exe = ($procs | Where-Object { $_.Path } | Select-Object -First 1).Path',
    "if (-not $exe -and $fallback) { $exe = $fallback }",
    "if (-not $exe) { Say 'could not find the DeepSeek Harness program; quit and reopen it by hand'; exit 1 }",
    "Say ('closing ' + $procs.Count + ' process(es)')",
    '$procs | ForEach-Object { [void]$_.CloseMainWindow() }',
    "& taskkill.exe /IM 'DeepSeek Harness.exe' 2>$null | Out-Null",
    "for ($i = 0; $i -lt 60 -and @(Get-Process | Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' }).Count -gt 0; $i++) { Start-Sleep -Seconds 1 }",
    "$left = @(Get-Process | Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' })",
    "if ($left.Count -gt 0) { Say ('forcing ' + $left.Count + ' process(es) to stop'); $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }",
    "try { Start-Process -FilePath $exe; Say 'reopened' } catch { Say ('could not reopen: ' + $_.Exception.Message) }",
    '',
  ].join('\r\n');
}
