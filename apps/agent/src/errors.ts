/**
 * Error taxonomy and close-code classification for the DSH RC agent.
 *
 * The agent has exactly two reactions to a failure: retry with backoff, or
 * stop and explain why. Keeping that decision in one table means a new close
 * code cannot silently turn a revoked device into a reconnect loop.
 */
import { CloseCode } from '@dsh-rc/protocol';

export const AUTHENTICATION_HINT =
  'DSH requires authentication: start through the DSH RC plugin or pass an authenticated URL (http://127.0.0.1:<port>/?token=...).';

export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** A failure that must never be retried: revoked device, bad secret, bad protocol. */
export class TerminalAgentError extends AgentError {
  constructor(code: string, message: string) {
    super(code, message, false);
    this.name = 'TerminalAgentError';
  }
}

/** The edge answered HELLO with `ok:false`. */
export class HelloRejectedError extends AgentError {
  constructor(code: string, message: string, retryable: boolean) {
    super(code, message, retryable);
    this.name = 'HelloRejectedError';
  }
}

/** Non-2xx HTTP response from the edge's device API. */
export class EdgeHttpError extends AgentError {
  readonly status: number;

  constructor(status: number, message: string, retryable: boolean) {
    super(`EDGE_HTTP_${String(status)}`, message, retryable);
    this.name = 'EdgeHttpError';
    this.status = status;
  }
}

/** The launch token exchange failed, or the upstream demands a credential we lack. */
export class DshAuthError extends AgentError {
  constructor(message: string) {
    super('DSH_AUTH_REQUIRED', message, false);
    this.name = 'DshAuthError';
  }
}

const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.ProtocolMismatch, // 4001
  CloseCode.AuthFailed, // 4002
  CloseCode.DeviceRevoked, // 4003
]);

export function isTerminalCloseCode(code: number): boolean {
  return TERMINAL_CLOSE_CODES.has(code);
}

/** Human-readable, actionable explanation for a tunnel close code. */
export function describeCloseCode(code: number, reason: string): string {
  switch (code) {
    case CloseCode.ProtocolMismatch:
      return `edge rejected the tunnel protocol version (PROTOCOL_MISMATCH): ${reason}`;
    case CloseCode.AuthFailed:
      return `edge rejected this device's secret (AUTH_FAILED); delete ${'<state-dir>/device.json'} and restart to re-pair. ${reason}`;
    case CloseCode.DeviceRevoked:
      return 'this device was revoked; pair a new device from the DSH RC dashboard.';
    case CloseCode.HeartbeatTimeout:
      return `tunnel heartbeat timed out: ${reason}`;
    case CloseCode.TunnelReplaced:
      return `a newer tunnel replaced this one: ${reason}`;
    case CloseCode.ServerDraining:
      return `edge is draining: ${reason}`;
    default:
      return reason === '' ? `tunnel closed (${String(code)})` : reason;
  }
}

/** HELLO_ACK failure codes that are terminal per PROTOCOL.md §4.6 / §5. */
export function isTerminalHelloCode(code: string): boolean {
  return code === 'PROTOCOL_MISMATCH' || code === 'AUTH_FAILED' || code === 'DEVICE_REVOKED';
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Promise helpers that never reject for control-flow only. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}