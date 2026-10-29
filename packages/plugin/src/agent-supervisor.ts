/**
 * Agent process supervisor.
 *
 * The plugin does not link the agent in-process: a crashing tunnel must not
 * take the Harness down with it, and the agent's CLI contract
 * (`--edge --dsh-url-file --state-dir --name --status-file --log-level`) is
 * the documented interface. The DSH launch token travels in a 0600 JSON file,
 * not in argv. This module owns spawn, the status file, stdout
 * parsing, and restart-with-backoff.
 *
 * Trust boundary: `dshUrl` carries the process launch token. It is passed as
 * argv (visible to the same user through `ps`, exactly like the DSH process
 * itself) and is never logged, stored, or put in the status file by us.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { isAgentState } from './contract.js';
import type { AgentState, AgentStatus, DshRcStatus } from './contract.js';
import type { PluginConfig } from './config.js';

export interface SupervisorLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SupervisorOptions {
  config: PluginConfig;
  /**
   * Edge-bootstrapped DSH URL including the launch token. Resolved lazily
   * because the web server may not have bound its port when apply runs. The
   * value is written to `upstream.json` (0600), never passed in argv and
   * never logged.
   */
  dshUrl: () => string;
  deviceName: string;
  stateDir: string;
  pluginRoot: string;
  logger: SupervisorLogger;
}

export interface LaunchTarget {
  /** Executable to spawn: a Node runtime, the Electron binary, or a PATH command. */
  command: string;
  /** Arguments before the agent's own flags. */
  prefixArgs: string[];
  /** Human-readable entry for status/debugging. */
  display: string;
  /**
   * The command is the Electron binary, which behaves as Node only when
   * `ELECTRON_RUN_AS_NODE=1` is set explicitly for the child.
   */
  electron?: boolean;
  /**
   * The command is DSH's `runtime/bin/node` shell wrapper, which needs
   * `DSH_DESKTOP_NODE_EXECUTABLE` pointing at the Electron binary.
   */
  runtimeWrapper?: boolean;
}

/** Restart policy: full-jitter exponential backoff, 500 ms → 30 s. */
const RESTART_BASE_MS = 500;
const RESTART_MAX_MS = 30_000;
/** Consecutive spawn failures (ENOENT/EACCES) before we stop retrying. */
const MAX_SPAWN_FAILURES = 3;
const STATUS_POLL_MS = 1_000;
const STOP_GRACE_MS = 5_000;
/** Uptime after which a crash no longer counts toward the backoff exponent. */
const HEALTHY_UPTIME_MS = 60_000;
/**
 * Self-heal: after a stop that used to be final (terminal error, repeated spawn
 * failures) try again on this slow cadence, so a fixed cause (an update, a
 * reset edge, a returned network) reconnects with nobody pressing Restart.
 * Only a revoked device stays stopped: that is the owner's decision.
 */
const HEAL_RETRY_MS = 5 * 60_000;

export function isOwnerRevocation(reason: string): boolean {
  return /revoked/i.test(reason);
}

export class AgentSupervisor {
  readonly statusFile: string;

  private readonly options: SupervisorOptions;
  private readonly logger: SupervisorLogger;
  private child: ChildProcess | undefined;
  private pairUrl: string | undefined;
  private pairUrlSource: 'file' | 'stdout' | undefined;
  private agentStatus: AgentStatus | undefined;
  private localState: AgentState = 'stopped';
  private localError: string | undefined;
  private lastExit: { code: number | null; signal: string | null; at: number } | undefined;
  private restarts = 0;
  private attempt = 0;
  private spawnFailures = 0;
  private spawnedAt = 0;
  private stoppedAt = 0;
  private stopping = false;
  private disposed = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last status the agent reported before exiting; decides terminal vs retry. */
  private lastAgentState: AgentStatus | undefined;
  private resolvedTarget: LaunchTarget | undefined;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.logger = options.logger;
    this.statusFile = join(options.stateDir, 'status.json');
    this.upstreamFile = join(options.stateDir, 'upstream.json');
  }

  /**
   * Credential handoff file. The agent reads the authenticated DSH URL from
   * here instead of argv, so `ps` never exposes the launch token.
   */
  readonly upstreamFile: string;

  /** Current merged status: supervisor facts win over a stale agent file. */
  status(): DshRcStatus {
    const running = this.child !== undefined;
    const state: AgentState = running ? (this.agentStatus?.state ?? 'starting') : this.localState;
    const base: DshRcStatus = {
      state,
      enabled: this.options.config.enabled,
      autoStart: this.options.config.autoStart,
      deviceName: this.options.deviceName,
      edgeUrl: this.options.config.edgeUrl,
      reconnects: this.agentStatus?.reconnects ?? 0,
      since: this.agentStatus?.since ?? (running ? this.spawnedAt : this.stoppedAt || Date.now()),
      agentRunning: running,
      restarts: this.restarts,
      stateDir: this.options.stateDir,
    };
    const pairUrl = this.pairUrl ?? this.agentStatus?.pairUrl;
    if (pairUrl !== undefined) base.pairUrl = pairUrl;
    const deviceId = this.agentStatus?.deviceId;
    if (deviceId !== undefined) base.deviceId = deviceId;
    const latencyMs = this.agentStatus?.latencyMs;
    if (latencyMs !== undefined) base.latencyMs = latencyMs;
    const upstream = this.agentStatus?.upstream;
    if (upstream !== undefined) base.upstream = upstream;
    const lastError = this.localError ?? this.agentStatus?.lastError;
    if (lastError !== undefined) base.lastError = lastError;
    if (this.resolvedTarget !== undefined) base.agentEntry = this.resolvedTarget.display;
    const pid = this.child?.pid;
    if (pid !== undefined) base.pid = pid;
    if (this.lastExit !== undefined) base.lastExit = this.lastExit;
    return base;
  }

  pairUrlValue(): string | undefined {
    return this.pairUrl ?? this.agentStatus?.pairUrl;
  }

  /** Start the agent if it is not already running. Operational failures become status. */
  async start(): Promise<DshRcStatus> {
    if (this.disposed) throw new Error('dsh-rc: plugin is disposed');
    if (this.child !== undefined) return this.status();
    this.stopping = false;
    this.localState = 'starting';
    this.localError = undefined;
    this.lastAgentState = undefined;
    this.stoppedAt = 0;
    await this.launch();
    return this.status();
  }

  /** SIGTERM, then SIGKILL after a grace period. Always resolves. */
  async stop(): Promise<DshRcStatus> {
    this.stopping = true;
    this.clearRestartTimer();
    this.stopPolling();
    this.localState = 'stopped';
    this.stoppedAt = Date.now();
    this.localError = undefined;
    this.pairUrl = undefined;
    this.pairUrlSource = undefined;
    this.agentStatus = undefined;
    this.lastAgentState = undefined;
    this.spawnFailures = 0;
    this.attempt = 0;
    await this.removeUpstreamFile();
    try { this.awakeGuard?.kill(); } catch { /* already gone */ }
    this.awakeGuard = undefined;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      await waitForExit(child, STOP_GRACE_MS);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    return this.status();
  }

  /** Stop then start, clearing the backoff counter. */
  async restart(): Promise<DshRcStatus> {
    await this.stop();
    this.stopping = false;
    this.attempt = 0;
    this.spawnFailures = 0;
    return this.start();
  }

  /** Idempotent teardown used by the owning cordis fiber. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
  }

  /* ----------------------------- launching ----------------------------- */

  private buildArgs(): string[] {
    const { config } = this.options;
    const args = [
      '--edge',
      config.edgeUrl,
      '--dsh-url-file',
      this.upstreamFile,
      '--state-dir',
      this.options.stateDir,
      '--name',
      this.options.deviceName,
      '--status-file',
      this.statusFile,
      '--log-level',
      config.logLevel,
    ];
    const insecure = config.insecure ?? config.edgeUrl.startsWith('http://');
    if (insecure) args.push('--insecure');
    return args;
  }

  private async launch(): Promise<void> {
    if (this.disposed || this.stopping) return;
    if (this.options.dshUrl() === '') {
      this.localState = 'error';
      this.localError = 'DSH authenticated URL unavailable; the web server has not bound a port yet. Restart the agent once the Harness is serving.';
      this.logger.error('cannot start agent: empty DSH URL');
      return;
    }

    const target = this.resolveTarget();
    if (target === undefined) {
      this.localState = 'error';
      this.localError =
        'Agent entry not found. Set agentEntry, DSHRC_AGENT, build apps/agent (dist/main.js), or install the dsh-rc CLI on PATH.';
      this.logger.error('cannot start agent: no launch target');
      return;
    }
    this.resolvedTarget = target;

    // Credential handoff: 0700 dir, 0600 file, atomic replace. The launch
    // token changes with every DSH process, so the file is rewritten on each
    // (re)start rather than reused.
    try {
      await this.writeUpstreamFile(this.options.dshUrl());
    } catch (error) {
      this.localState = 'error';
      this.localError = `Could not write the agent credential file: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error('upstream file write failed', { file: this.upstreamFile });
      return;
    }

    await rm(this.statusFile, { force: true }).catch(() => undefined);

    let child: ChildProcess;
    try {
      child = spawn(target.command, [...target.prefixArgs, ...this.buildArgs()], {
        env: agentChildEnv(target),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.spawnFailure = error instanceof Error ? error : new Error(String(error));
      this.localState = 'error';
      this.localError = `Agent failed to start (${this.spawnFailure.message}).`;
      this.logger.error('agent spawn threw', { message: this.spawnFailure.message });
      this.spawnFailures += 1;
      if (this.spawnFailures < MAX_SPAWN_FAILURES) this.scheduleRestart();
      return;
    }

    this.child = child;
    this.spawnedAt = Date.now();
    this.localState = 'starting';
    this.localError = undefined;
    let exited = false;

    child.once('error', (error) => {
      // ENOENT/EACCES from spawn: no exit event follows on every platform, and
      // 'close' reports the same condition, so record it once and let close
      // drive the restart decision.
      if (exited) return;
      this.spawnFailure = error;
    });
    child.once('close', (code, signal) => {
      if (exited) return;
      exited = true;
      this.onChildClose(child, code, signal);
    });

    if (child.stdout !== null) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => this.handleStdout(line));
    }
    if (child.stderr !== null) {
      const lines = createInterface({ input: child.stderr });
      lines.on('line', (line) => this.handleStderr(line));
    }

    this.logger.info('agent started', {
      entry: target.display,
      pid: child.pid ?? null,
      edgeUrl: this.options.config.edgeUrl,
      stateDir: this.options.stateDir,
    });
    this.startPolling();
    this.holdAwake(child);
  }

  /**
   * macOS: keep the Mac from idle-sleeping while the agent runs, otherwise an
   * office desktop drops off the edge as soon as it idles. `caffeinate -w`
   * exits by itself when the agent does. Opt out with DSHRC_KEEP_AWAKE=0.
   */
  private holdAwake(child: ChildProcess): void {
    if (process.platform !== 'darwin' || child.pid === undefined) return;
    if (process.env['DSHRC_KEEP_AWAKE'] === '0') return;
    try {
      const guard = spawn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore', detached: true });
      guard.on('error', () => undefined);
      guard.unref();
      this.awakeGuard = guard;
    } catch {
      /* best effort */
    }
  }

  private spawnFailure: Error | undefined;
  private awakeGuard: ChildProcess | undefined;

  private onChildClose(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.stopPolling();
    this.lastAgentState = this.agentStatus;
    this.agentStatus = undefined;
    this.lastExit = { code, signal, at: Date.now() };
    // The credential file must not outlive the process that used it.
    void this.removeUpstreamFile();
    if (this.stopping || this.disposed) {
      this.localState = 'stopped';
      return;
    }

    const failure = this.spawnFailure;
    this.spawnFailure = undefined;
    if (failure !== undefined) {
      this.spawnFailures += 1;
      this.localState = 'error';
      this.localError = `Agent failed to start (${failure.message}).`;
      this.logger.error('agent spawn failed', { message: failure.message, attempt: this.spawnFailures });
      if (this.spawnFailures >= MAX_SPAWN_FAILURES) {
        this.localError = `Agent failed to start ${String(this.spawnFailures)} times (${failure.message}). Trying again in 5 minutes.`;
        this.scheduleHeal(this.localError);
        return;
      }
    } else {
      this.spawnFailures = 0;
      const uptime = Date.now() - this.spawnedAt;
      if (uptime >= HEALTHY_UPTIME_MS) this.attempt = 0;
      // Exit code 1 is terminal per the agent contract (revoked, auth,
      // protocol mismatch, state-dir lock). The agent also writes an `error`
      // status with an actionable lastError before exiting; do not restart
      // into the same terminal condition.
      // A lock held by a previous plugin instance that is still shutting down
      // (hot reload of the web server) is transient, not terminal.
      const lockContention = /already running/i.test(this.lastAgentState?.lastError ?? '');
      const terminal = code === 1 && this.lastAgentState?.state === 'error' && !lockContention;
      const reason = this.lastAgentState?.lastError ?? `Agent exited (${code === null ? String(signal) : `code ${String(code)}`}).`;
      if (terminal) {
        this.localState = 'error';
        this.localError = isOwnerRevocation(reason) ? reason : `${reason} Trying again in 5 minutes.`;
        this.logger.error('agent stopped with a terminal error', { code, reason });
        this.scheduleHeal(reason);
        return;
      }
      this.localState = 'reconnecting';
      this.localError = reason;
      this.logger.warn('agent exited; scheduling restart', { code, signal, uptimeMs: uptime });
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== undefined || this.stopping || this.disposed) return;
    const exponential = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(this.attempt, 6));
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.attempt += 1;
    this.restarts += 1;
    this.logger.info('agent restart scheduled', { delayMs: delay, restarts: this.restarts });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.launch().catch((error: unknown) => {
        this.logger.error('agent relaunch failed', { message: error instanceof Error ? error.message : String(error) });
      });
    }, delay);
    // Do not keep the Harness process alive just for a pending restart.
    this.restartTimer.unref?.();
  }

  private scheduleHeal(reason: string): void {
    if (this.restartTimer !== undefined || this.stopping || this.disposed || isOwnerRevocation(reason)) return;
    this.logger.info('agent self-heal retry scheduled', { delayMs: HEAL_RETRY_MS });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.attempt = 0;
      this.spawnFailures = 0;
      void this.launch().catch((error: unknown) => {
        this.logger.error('agent self-heal relaunch failed', { message: error instanceof Error ? error.message : String(error) });
      });
    }, HEAL_RETRY_MS);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  /* ------------------------------ status ------------------------------ */

  private startPolling(): void {
    this.stopPolling();
    void this.readStatusFile();
    this.pollTimer = setInterval(() => {
      void this.readStatusFile();
    }, STATUS_POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async readStatusFile(): Promise<void> {
    if (this.child === undefined || this.disposed) return;
    try {
      const info = statSync(this.statusFile);
      if (info.mtimeMs < this.spawnedAt - 1_000) return; // stale file from a previous run
      const text = await readFile(this.statusFile, 'utf8');
      const parsed = parseAgentStatus(text);
      if (parsed !== undefined) this.applyAgentStatus(parsed);
    } catch {
      /* absent until the agent writes its first status */
    }
  }

  private applyAgentStatus(next: AgentStatus): void {
    const previous = this.agentStatus;
    this.agentStatus = next;
    // The status file is authoritative for the pair URL; stdout is a fallback
    // for agents that only print it.
    if (next.pairUrl !== undefined && next.pairUrl !== '') {
      this.pairUrl = next.pairUrl;
      this.pairUrlSource = 'file';
    }
    if (previous?.state !== next.state || previous?.lastError !== next.lastError) {
      this.logger.info('agent state', {
        state: next.state,
        deviceId: next.deviceId ?? null,
        reconnects: next.reconnects,
        latencyMs: next.latencyMs ?? null,
      });
    }
  }

  private handleStdout(line: string): void {
    const parsed = interpretAgentLine(line);
    if (parsed === undefined) {
      if (line.trim() !== '') this.logger.debug('agent', { line: sanitizeLine(line) });
      return;
    }
    if (parsed.pairUrl !== undefined && this.pairUrlSource !== 'file') {
      this.pairUrl = parsed.pairUrl;
      this.pairUrlSource = 'stdout';
      this.logger.info('pair URL received (stdout)', { pairUrl: parsed.pairUrl });
    }
    if (parsed.status !== undefined) {
      const previous = this.agentStatus;
      const merged: AgentStatus = {
        state: parsed.status.state ?? previous?.state ?? 'starting',
        reconnects: parsed.status.reconnects ?? previous?.reconnects ?? 0,
        since: parsed.status.since ?? previous?.since ?? Date.now(),
        edgeUrl: parsed.status.edgeUrl ?? previous?.edgeUrl ?? this.options.config.edgeUrl,
      };
      const deviceId = parsed.status.deviceId ?? previous?.deviceId;
      if (deviceId !== undefined) merged.deviceId = deviceId;
      const lastError = parsed.status.lastError ?? previous?.lastError;
      if (lastError !== undefined) merged.lastError = lastError;
      const latencyMs = parsed.status.latencyMs ?? previous?.latencyMs;
      if (latencyMs !== undefined) merged.latencyMs = latencyMs;
      const upstream = parsed.status.upstream ?? previous?.upstream;
      if (upstream !== undefined) merged.upstream = upstream;
      const pairUrl = parsed.pairUrl ?? previous?.pairUrl;
      if (pairUrl !== undefined) merged.pairUrl = pairUrl;
      this.applyAgentStatus(merged);
    }
  }

  private handleStderr(line: string): void {
    const text = line.trim();
    if (text === '') return;
    if (text.length > 2_000) {
      this.logger.warn('agent stderr', { line: sanitizeLine(text.slice(0, 2_000)) });
      return;
    }
    this.logger.warn('agent stderr', { line: sanitizeLine(text) });
  }

  /* ------------------------- credential handoff ------------------------ */

  /**
   * Write `{ url, createdAt }` atomically with owner-only permissions.
   * `mkdir`'s mode is advisory when the directory already exists, so the file
   * mode is set explicitly as well.
   */
  private async writeUpstreamFile(url: string): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.upstreamFile}.tmp-${String(process.pid)}-${String(Date.now())}`;
    const body = JSON.stringify({ url, createdAt: Date.now() });
    await writeFile(temporary, body, { mode: 0o600, encoding: 'utf8' });
    await rename(temporary, this.upstreamFile);
    await chmod(this.upstreamFile, 0o600).catch(() => undefined);
  }

  private async removeUpstreamFile(): Promise<void> {
    await rm(this.upstreamFile, { force: true }).catch(() => undefined);
  }

  /* ---------------------------- resolution ---------------------------- */

  private resolveTarget(): LaunchTarget | undefined {
    const explicit = this.options.config.agentEntry;
    if (explicit !== undefined && explicit !== '') {
      return targetFromSpec(explicit, this.options.pluginRoot) ?? undefined;
    }
    const fromEnv = process.env['DSHRC_AGENT']?.trim();
    if (fromEnv !== undefined && fromEnv !== '') {
      const target = targetFromSpec(fromEnv, this.options.pluginRoot);
      if (target !== undefined) return target;
    }
    for (const candidate of agentCandidates(this.options.pluginRoot)) {
      if (isFile(candidate)) return { ...resolveNodeCommand(), prefixArgs: [candidate], display: candidate };
    }
    const onPath = findOnPath('dsh-rc');
    if (onPath !== undefined) return { command: onPath, prefixArgs: [], display: onPath };
    return undefined;
  }
}

/* ------------------------------ helpers ------------------------------ */

/** Candidate build outputs, nearest first. */
function agentCandidates(pluginRoot: string): string[] {
  return [
    join(pluginRoot, 'apps', 'agent', 'dist', 'main.js'),
    join(pluginRoot, '..', 'apps', 'agent', 'dist', 'main.js'),
    join(pluginRoot, '..', '..', 'apps', 'agent', 'dist', 'main.js'),
    join(pluginRoot, 'node_modules', '@dsh-rc', 'agent', 'dist', 'main.js'),
  ];
}

/**
 * Interpret a configured agent entry. A path-like value must exist; a bare
 * name is treated as a PATH command (spawn reports ENOENT as a status error).
 */
export function targetFromSpec(spec: string, pluginRoot: string): LaunchTarget | undefined {
  const trimmed = spec.trim();
  if (trimmed === '') return undefined;
  const pathLike =
    trimmed.startsWith('.') ||
    trimmed.startsWith('~') ||
    isAbsolute(trimmed) ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    /\.(?:js|mjs|cjs|ts)$/i.test(trimmed);
  if (!pathLike) {
    return { command: trimmed, prefixArgs: [], display: trimmed };
  }
  const expanded = trimmed.startsWith('~/') ? join(process.env['HOME'] ?? '', trimmed.slice(2)) : trimmed;
  const absolute = isAbsolute(expanded) ? expanded : resolve(pluginRoot, expanded);
  if (isFile(absolute)) return { ...resolveNodeCommand(), prefixArgs: [absolute], display: absolute };
  if (isDirectory(absolute)) {
    for (const entry of ['dist/main.js', 'main.js', 'dist/index.js', 'index.js']) {
      const candidate = join(absolute, entry);
      if (isFile(candidate)) return { ...resolveNodeCommand(), prefixArgs: [candidate], display: candidate };
    }
  }
  return undefined;
}

/**
 * Pick the Node runtime used to run the agent entry point.
 *
 * In the DSH desktop app `process.execPath` is the Electron binary. Spawning
 * it without `ELECTRON_RUN_AS_NODE=1` starts another application instance
 * instead of a script host, so the preference order is:
 *
 * 1. `DSHRC_NODE` (explicit operator override),
 * 2. `DSH_NODE`,
 * 3. the DSH runtime wrapper at `<resources>/runtime/bin/node`,
 * 4. `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (safe under plain Node:
 *    the variable is ignored).
 *
 * @returns the command stem for a launch target.
 */
export function resolveNodeCommand(env: NodeJS.ProcessEnv = process.env): Pick<LaunchTarget, 'command' | 'electron' | 'runtimeWrapper'> {
  for (const key of ['DSHRC_NODE', 'DSH_NODE']) {
    const candidate = env[key]?.trim();
    if (candidate !== undefined && candidate !== '' && isFile(candidate)) {
      return { command: candidate, electron: false, runtimeWrapper: false };
    }
  }

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath !== undefined && resourcesPath !== '' && process.platform !== 'win32') {
    const wrapper = join(resourcesPath, 'runtime', 'bin', 'node');
    if (isFile(wrapper)) return { command: wrapper, electron: false, runtimeWrapper: true };
  }

  return {
    command: process.execPath,
    electron: typeof process.versions.electron === 'string',
    runtimeWrapper: false,
  };
}

/**
 * Environment for the agent child. Exported for tests: the Electron flag is a
 * correctness requirement in the desktop app, not an optimization.
 *
 * @param target resolved launch target.
 * @param base environment to copy (defaults to `process.env`).
 * @returns a fresh environment object; the caller's object is not mutated.
 */
export function agentChildEnv(target: LaunchTarget, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (target.electron === true) env['ELECTRON_RUN_AS_NODE'] = '1';
  if (target.runtimeWrapper === true) env['DSH_DESKTOP_NODE_EXECUTABLE'] ??= process.execPath;
  return env;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findOnPath(command: string): string | undefined {
  const paths = (process.env['PATH'] ?? '').split(delimiter);
  const extensions = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const directory of paths) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    timer.unref?.();
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

/** Parse the agent's atomic JSON status file. Returns undefined for junk. */
export function parseAgentStatus(text: string): AgentStatus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!isAgentState(record['state'])) return undefined;
  const status: AgentStatus = {
    state: record['state'],
    reconnects: typeof record['reconnects'] === 'number' && Number.isFinite(record['reconnects']) ? record['reconnects'] : 0,
    since: typeof record['since'] === 'number' && Number.isFinite(record['since']) ? record['since'] : Date.now(),
  };
  const strings = ['deviceId', 'pairUrl', 'edgeUrl', 'lastError', 'upstream'] as const;
  for (const key of strings) {
    const field = record[key];
    if (typeof field === 'string' && field !== '') {
      (status as unknown as Record<string, unknown>)[key] = field;
    }
  }
  const latency = record['latencyMs'];
  if (typeof latency === 'number' && Number.isFinite(latency)) status.latencyMs = latency;
  return status;
}

export interface InterpretedLine {
  status?: Partial<AgentStatus>;
  pairUrl?: string;
}

/**
 * Interpret one stdout line. The agent contract says "print pair URL and
 * status transitions as JSON lines"; we also accept the plain
 * `DSHRC_PAIR_URL <url>` marker and a `Pair URL: <url>` human line so a
 * partially-landed agent still works.
 */
export function interpretAgentLine(line: string): InterpretedLine | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;

  if (trimmed.startsWith('DSHRC_PAIR_URL')) {
    const url = trimmed.slice('DSHRC_PAIR_URL'.length).replace(/^[=:\s]+/, '').trim();
    if (url !== '') return { pairUrl: url };
  }

  if (trimmed.startsWith('{')) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = undefined;
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      const result: InterpretedLine = {};
      if (isAgentState(record['state'])) {
        const status: Partial<AgentStatus> = { state: record['state'] };
        if (typeof record['deviceId'] === 'string') status.deviceId = record['deviceId'];
        if (typeof record['reconnects'] === 'number') status.reconnects = record['reconnects'];
        if (typeof record['latencyMs'] === 'number') status.latencyMs = record['latencyMs'];
        if (typeof record['lastError'] === 'string') status.lastError = record['lastError'];
        if (typeof record['since'] === 'number') status.since = record['since'];
        if (typeof record['upstream'] === 'string') status.upstream = record['upstream'];
        if (typeof record['edgeUrl'] === 'string') status.edgeUrl = record['edgeUrl'];
        result.status = status;
      }
      const pairCandidate = record['pairUrl'] ?? record['url'];
      const kind = String(record['event'] ?? record['type'] ?? '').toLowerCase();
      if (typeof pairCandidate === 'string' && (pairCandidate.startsWith('http://') || pairCandidate.startsWith('https://'))) {
        if (record['pairUrl'] !== undefined || kind.includes('pair')) result.pairUrl = pairCandidate;
      }
      if (result.status !== undefined || result.pairUrl !== undefined) return result;
    }
  }

  const match = /pair(?:ing)?\s*url\s*:?\s*(https?:\/\/\S+)/i.exec(trimmed);
  if (match?.[1] !== undefined) return { pairUrl: match[1] };
  return undefined;
}

/** Log lines can carry a token accidentally; strip query strings and cap length. */
function sanitizeLine(line: string): string {
  return line
    .replace(/([?&](?:token|code|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .slice(0, 500);
}

/** Directory of this module when bundled to `dist/index.js`. */
export function defaultPluginRoot(moduleUrl: string): string {
  try {
    return dirname(dirname(fileURLToPath(moduleUrl)));
  } catch {
    return process.cwd();
  }
}