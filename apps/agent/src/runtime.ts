/**
 * Agent lifecycle: identity → pairing → tunnel → proxy, with full-jitter
 * reconnect and terminal-failure classification.
 *
 * `startAgent` deliberately returns as soon as the first identity step has
 * settled; pairing approval, connection and reconnection happen in the
 * background so the DSH plugin can show the pair URL immediately.
 */
import os from 'node:os';
import { createLogger, platformLabel, VERSION, type Logger } from '@dsh-link/shared';
import type { Stream } from '@dsh-link/mux';
import { fullJitterDelay, type BackoffOptions } from './backoff.js';
import { DshSession, readDshUrlFile } from './dsh-session.js';
import { EdgeClient, isApprovedStatus, isRevokedStatus, sanitizePairUrl } from './edge-client.js';
import {
  AgentError,
  EdgeHttpError,
  HelloRejectedError,
  TerminalAgentError,
  messageOf,
  sleep,
} from './errors.js';
import { loadIdentity, saveIdentity, type DeviceIdentity } from './identity.js';
import { acquireInstanceLock, type InstanceLock } from './lock.js';
import { DEFAULT_MAX_BODY_BYTES, handleHttpStream, type UpstreamReporter } from './proxy-http.js';
import { handleWsStream } from './proxy-ws.js';
import { StatusTracker } from './status.js';
import { classifyTunnelClose, openTunnel, type TunnelConnection } from './tunnel.js';
import type { AgentHandle, AgentOptions, AgentState, AgentStatus } from './types.js';

export const DEFAULT_PAIR_POLL_MS = 2_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const LATENCY_REFRESH_MS = 15_000;

interface OnlineWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RuntimeInternals {
  pairPollMs?: number;
  connectTimeoutMs?: number;
  backoff?: BackoffOptions;
  maxBodyBytes?: number;
}

/**
 * Launch URL precedence: `dshUrlFile` (plugin-owned, keeps the token out of
 * argv) > `dshUrl` (inline `?token=` allowed for manual runs) > plain origin.
 * An explicit `dshToken` option still wins over a token embedded in either.
 */
function resolveDshSource(options: AgentOptions, logger: Logger): { dshUrl: string; dshToken?: string } {
  let dshUrl = options.dshUrl;
  if (options.dshUrlFile !== undefined && options.dshUrlFile !== '') {
    dshUrl = readDshUrlFile(options.dshUrlFile, logger);
  }
  const token = options.dshToken;
  return { dshUrl, ...(token === undefined || token === '' ? {} : { dshToken: token }) };
}

export class AgentRuntime implements AgentHandle {
  readonly logger: Logger;
  private readonly options: AgentOptions;
  private readonly edge: EdgeClient;
  private readonly session: DshSession;
  private readonly tracker: StatusTracker;
  private readonly internals: RuntimeInternals;
  private readonly abort = new AbortController();
  private readonly onlineWaiters: OnlineWaiter[] = [];
  private readonly donePromise: Promise<void>;
  private resolveDone: (() => void) | undefined;
  private doneResolved = false;

  private identity: DeviceIdentity | undefined;
  private connection: TunnelConnection | undefined;
  private lock: InstanceLock | undefined;
  private exitHandler: (() => void) | undefined;
  private stopPromise: Promise<void> | undefined;
  private latencyTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private terminal = false;
  private waitingForApproval = false;
  private reconnects = 0;
  private attempt = 0;
  private tunnelAttempted = false;
  private authProblem = false;
  private readonly reporter: UpstreamReporter;

  constructor(options: AgentOptions, internals: RuntimeInternals = {}) {
    if (typeof options.stateDir !== 'string' || options.stateDir.trim() === '') {
      throw new TerminalAgentError('AGENT_CONFIG', 'stateDir is required');
    }
    this.options = options;
    this.internals = internals;
    this.logger = options.logger ?? createLogger('dsh-link-agent');
    const source = resolveDshSource(options, this.logger);
    this.session = new DshSession({
      dshUrl: source.dshUrl,
      ...(source.dshToken === undefined ? {} : { dshToken: source.dshToken }),
      logger: this.logger.child({ component: 'dsh-session' }),
    });
    this.edge = new EdgeClient({
      edgeUrl: options.edgeUrl,
      insecure: options.insecure === true,
      logger: this.logger.child({ component: 'edge' }),
    });
    this.tracker = new StatusTracker(
      { edgeUrl: this.edge.endpoint.apiBase, upstream: this.session.target.origin },
      options.onStatus,
      this.logger,
    );
    this.reporter = {
      authRequired: (message: string) => {
        this.authProblem = true;
        this.logger.warn('upstream authentication is required', { message });
        if (this.tracker.value().state !== 'error') {
          this.publish({ state: 'error', lastError: message });
        }
      },
      healthy: () => {
        if (!this.authProblem) return;
        this.authProblem = false;
        const current = this.tracker.value();
        if (current.state === 'error' && this.connection !== undefined && !this.stopping) {
          this.publish({ state: 'online', lastError: undefined });
        }
      },
    };
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Extra (non-public-API) signal used by the CLI to choose its exit code. */
  get done(): Promise<void> {
    return this.donePromise;
  }

  /** Build the runtime and perform the first identity step before returning. */
  static async start(options: AgentOptions, internals: RuntimeInternals = {}): Promise<AgentRuntime> {
    const runtime = new AgentRuntime(options, internals);
    await runtime.initialize();
    return runtime;
  }

  status(): AgentStatus {
    const snapshot = this.tracker.value();
    const connection = this.connection;
    if (connection !== undefined) {
      const rtt = connection.mux.stats().rttMs;
      if (rtt !== undefined && rtt !== snapshot.latencyMs) return { ...snapshot, latencyMs: rtt };
    }
    return snapshot;
  }

  waitForOnline(timeoutMs?: number): Promise<void> {
    const current = this.tracker.value();
    if (current.state === 'online') return Promise.resolve();
    if (this.stopping) return Promise.reject(new Error('agent is stopped'));
    if (this.terminal) return Promise.reject(new Error(current.lastError ?? 'agent failed'));
    return new Promise<void>((resolve, reject) => {
      const waiter: OnlineWaiter = { resolve, reject };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`agent did not come online within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      this.onlineWaiters.push(waiter);
    });
  }

  async stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async initialize(): Promise<void> {
    this.tracker.announce();
    this.publish({ state: 'starting' });

    try {
      this.lock = acquireInstanceLock(this.options.stateDir, {
        logger: this.logger.child({ component: 'lock' }),
      });
    } catch (error) {
      // Another process owns this state dir: surface the reason and never
      // fight it for the tunnel (the edge would 4004 us forever).
      this.failTerminal(error);
      return;
    }
    this.exitHandler = () => {
      this.releaseLock();
    };
    process.once('exit', this.exitHandler);

    this.identity = loadIdentity(this.options.stateDir, this.logger);
    if (this.identity !== undefined) {
      // Even a previously persisted pair URL is re-validated: the file could
      // have been written by an older agent or tampered with.
      const safePairUrl = sanitizePairUrl(this.identity.pairUrl, this.edge.endpoint.apiBase, this.logger);
      if (safePairUrl === undefined) delete this.identity.pairUrl;
      else this.identity.pairUrl = safePairUrl;
    }
    if (this.identity !== undefined && this.identity.edgeUrl !== this.edge.endpoint.apiBase) {
      this.logger.warn('stored device identity belongs to a different edge; registering a new device', {
        storedEdge: this.identity.edgeUrl,
        edge: this.edge.endpoint.apiBase,
      });
      this.identity = undefined;
    }

    if (this.identity !== undefined) {
      this.waitingForApproval = this.identity.approvedAt === undefined;
      this.publish({
        state: this.waitingForApproval ? 'pairing' : 'connecting',
        deviceId: this.identity.deviceId,
        ...(this.identity.pairUrl === undefined ? {} : { pairUrl: this.identity.pairUrl }),
        reconnects: 0,
      });
    } else {
      this.publish({ state: 'pairing', reconnects: 0 });
      try {
        await this.register();
      } catch (error) {
        if (this.isTerminalError(error)) {
          this.failTerminal(error);
          return;
        }
        this.publish({ state: 'reconnecting', lastError: messageOf(error) });
        this.logger.warn('device registration failed; retrying', { error });
      }
    }

    void this.runLoop().catch((error: unknown) => {
      if (this.stopping) return;
      if (this.isTerminalError(error)) this.failTerminal(error);
      else {
        this.logger.error('agent loop crashed', { error });
        this.failTerminal(new TerminalAgentError('AGENT_CRASH', `agent loop crashed: ${messageOf(error)}`));
      }
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping && !this.terminal) {
      try {
        if (this.identity === undefined) {
          this.publish({ state: 'pairing' });
          await this.register();
        }
        if (this.waitingForApproval) {
          await this.waitForApproval();
        }
        if (this.stopping || this.terminal) break;

        const identity = this.identity;
        if (identity === undefined) throw new TerminalAgentError('AGENT_INTERNAL', 'identity missing before tunnel connect');

        this.publish({ state: 'connecting', deviceId: identity.deviceId, lastError: undefined });
        this.tunnelAttempted = true;
        const connection = await openTunnel({
          deviceId: identity.deviceId,
          deviceSecret: identity.deviceSecret,
          tunnelUrl: this.edge.endpoint.tunnelUrl,
          insecure: this.options.insecure === true,
          logger: this.logger.child({ component: 'tunnel' }),
          connectTimeoutMs: this.internals.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          onStream: (stream) => {
            this.handleStream(stream);
          },
        });

        // stop() may have raced the handshake; never publish "online" after
        // stop and never leave an orphan tunnel behind.
        if (this.stopping || this.terminal) {
          connection.close(1000, 'agent stopping');
          connection.terminate();
          break;
        }

        this.connection = connection;
        this.attempt = 0;
        this.publish({
          state: 'online',
          deviceId: identity.deviceId,
          ...(identity.pairUrl === undefined ? {} : { pairUrl: identity.pairUrl }),
          lastError: undefined,
          reconnects: this.reconnects,
          ...(connection.mux.stats().rttMs === undefined ? {} : { latencyMs: connection.mux.stats().rttMs }),
        });
        this.logger.info('tunnel online', {
          edgeUrl: this.edge.endpoint.apiBase,
          deviceId: identity.deviceId,
        });
        this.startLatencyTimer(connection);

        const close = await connection.closed;
        this.connection = undefined;
        this.stopLatencyTimer();
        if (this.stopping) break;

        const classification = classifyTunnelClose(close);
        if (!classification.retryable) {
          this.failTerminal(new TerminalAgentError(`TUNNEL_${String(close.code)}`, classification.message));
          break;
        }
        this.noteRetry(classification.message);
        this.logger.warn('tunnel closed; reconnecting', {
          code: close.code,
          reason: close.reason,
          reconnects: this.reconnects,
        });
        await this.backoffSleep();
      } catch (error) {
        this.connection = undefined;
        this.stopLatencyTimer();
        if (this.stopping) break;
        if (error instanceof HelloRejectedError && error.code === 'DEVICE_PENDING') {
          // The edge knows the device but the owner has not approved it yet.
          this.waitingForApproval = true;
          this.publish({ state: 'pairing', lastError: error.message });
          this.logger.info('device is pending approval; polling', { deviceId: this.identity?.deviceId });
          continue;
        }
        if (this.isTerminalError(error)) {
          this.failTerminal(error);
          break;
        }
        this.noteRetry(messageOf(error));
        this.logger.warn('agent retry scheduled', { error, reconnects: this.reconnects });
        await this.backoffSleep();
      }
    }
  }

  private async register(): Promise<void> {
    const name = (this.options.name ?? os.hostname()).slice(0, 128);
    const registered = await this.edge.registerDevice({
      name,
      platform: platformLabel(),
      agentVersion: VERSION,
    });
    const identity: DeviceIdentity = {
      version: 1,
      deviceId: registered.deviceId,
      deviceSecret: registered.deviceSecret,
      edgeUrl: this.edge.endpoint.apiBase,
      name,
      createdAt: Date.now(),
      ...(registered.pairUrl === undefined ? {} : { pairUrl: registered.pairUrl }),
    };
    const approved = isApprovedStatus(registered.status);
    if (approved) identity.approvedAt = Date.now();
    this.identity = identity;
    this.waitingForApproval = !approved;
    saveIdentity(this.options.stateDir, identity);
    this.publish({
      state: approved ? 'connecting' : 'pairing',
      deviceId: identity.deviceId,
      ...(identity.pairUrl === undefined ? {} : { pairUrl: identity.pairUrl }),
      lastError: undefined,
    });
    this.logger.info('device registered', {
      deviceId: identity.deviceId,
      approved,
    });
  }

  private async waitForApproval(): Promise<void> {
    const identity = this.identity;
    if (identity === undefined) return;
    const pollMs = this.internals.pairPollMs ?? DEFAULT_PAIR_POLL_MS;
    this.logger.info('waiting for device approval', { deviceId: identity.deviceId });
    while (!this.stopping && !this.terminal) {
      try {
        const state = await this.edge.getDevice(identity.deviceSecret);
        if (state.pairUrl !== undefined && state.pairUrl !== identity.pairUrl) {
          identity.pairUrl = state.pairUrl;
          this.publish({ pairUrl: state.pairUrl });
        }
        if (isRevokedStatus(state.status)) {
          throw new TerminalAgentError('DEVICE_REVOKED', 'this device was revoked before it was approved; register a new device.');
        }
        if (isApprovedStatus(state.status)) {
          identity.approvedAt = Date.now();
          saveIdentity(this.options.stateDir, identity);
          this.waitingForApproval = false;
          this.publish({ state: 'connecting', lastError: undefined });
          this.logger.info('device approved', { deviceId: identity.deviceId });
          return;
        }
      } catch (error) {
        if (this.isTerminalError(error)) throw error;
        if (error instanceof EdgeHttpError && !error.retryable) {
          throw new TerminalAgentError(error.code, error.message);
        }
        this.logger.warn('device approval poll failed; retrying', { error });
      }
      try {
        await sleep(pollMs, this.abort.signal);
      } catch {
        return;
      }
    }
  }

  private handleStream(stream: Stream): void {
    const target = this.session.target;
    const logger = this.logger.child({ component: 'proxy' });
    if (stream.kind === 'http') {
      handleHttpStream(stream, stream.open, {
        target,
        session: this.session,
        logger,
        reporter: this.reporter,
        maxBodyBytes: this.internals.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        connectTimeoutMs: 10_000,
      });
      return;
    }
    handleWsStream(stream, stream.open, {
      target,
      session: this.session,
      logger,
      reporter: this.reporter,
    });
  }

  private noteRetry(message: string): void {
    if (this.tunnelAttempted) this.reconnects += 1;
    this.publish({ state: 'reconnecting', reconnects: this.reconnects, lastError: message });
  }

  private async backoffSleep(): Promise<void> {
    const delay = fullJitterDelay(this.attempt, this.internals.backoff ?? {});
    this.attempt += 1;
    try {
      await sleep(delay, this.abort.signal);
    } catch {
      /* stopping */
    }
  }

  private isTerminalError(error: unknown): boolean {
    if (error instanceof AgentError) return !error.retryable;
    return false;
  }

  private failTerminal(error: unknown): void {
    if (this.terminal || this.stopping) return;
    const failure = error instanceof Error ? error : new Error(messageOf(error));
    this.terminal = true;
    this.stopLatencyTimer();
    this.logger.error('agent stopped permanently', {
      code: failure instanceof AgentError ? failure.code : 'AGENT_ERROR',
      error: failure,
    });
    this.publish({ state: 'error', lastError: failure.message });
    this.rejectWaiters(failure);
    this.releaseLock();
    this.resolveDoneOnce();
  }

  private publish(patch: Partial<AgentStatus> & { state?: AgentState }): AgentStatus {
    const status = this.tracker.update(patch);
    if (status.state === 'online') this.resolveWaiters();
    return status;
  }

  private resolveWaiters(): void {
    const waiters = this.onlineWaiters.splice(0, this.onlineWaiters.length);
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.onlineWaiters.splice(0, this.onlineWaiters.length);
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private removeWaiter(waiter: OnlineWaiter): void {
    const index = this.onlineWaiters.indexOf(waiter);
    if (index >= 0) this.onlineWaiters.splice(index, 1);
  }

  private startLatencyTimer(connection: TunnelConnection): void {
    this.stopLatencyTimer();
    this.latencyTimer = setInterval(() => {
      if (this.connection !== connection) return;
      const rtt = connection.mux.stats().rttMs;
      if (rtt !== undefined && rtt !== this.tracker.value().latencyMs) {
        this.tracker.update({ latencyMs: rtt });
      }
    }, LATENCY_REFRESH_MS);
    this.latencyTimer.unref?.();
  }

  private stopLatencyTimer(): void {
    if (this.latencyTimer !== undefined) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = undefined;
    }
  }

  private releaseLock(): void {
    if (this.exitHandler !== undefined) {
      process.off('exit', this.exitHandler);
      this.exitHandler = undefined;
    }
    const lock = this.lock;
    this.lock = undefined;
    try {
      lock?.release();
    } catch (error) {
      this.logger.warn('could not release the state directory lock', { error });
    }
  }

  private resolveDoneOnce(): void {
    if (this.doneResolved) return;
    this.doneResolved = true;
    this.resolveDone?.();
  }

  private async performStop(): Promise<void> {
    if (this.stopping) {
      await this.donePromise;
      return;
    }
    this.stopping = true;
    this.abort.abort(new Error('agent stopping'));
    this.stopLatencyTimer();
    const connection = this.connection;
    if (connection !== undefined) {
      connection.close(1000, 'agent stopping');
      await Promise.race([connection.closed, sleep(2_000)]).catch(() => undefined);
      connection.terminate();
      this.connection = undefined;
    }
    this.publish({ state: 'stopped' });
    this.logger.info('agent stopped');
    this.rejectWaiters(new Error('agent stopped'));
    this.releaseLock();
    this.resolveDoneOnce();
  }
}

/** Public entry point. Throws only for invalid configuration. */
export async function startAgent(options: AgentOptions): Promise<AgentHandle> {
  return AgentRuntime.start(options);
}