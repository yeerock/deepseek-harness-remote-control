/**
 * Public types for the DSH RC agent. `index.ts` re-exports these; the DSH
 * plugin imports them to type the status file and the in-process handle.
 */
import type { Logger } from '@dsh-rc/shared';

export type AgentState =
  | 'starting'
  | 'pairing'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'error'
  | 'stopped';

export interface AgentOptions {
  /** Public edge origin, e.g. `https://link.example.com` or `http://127.0.0.1:8787`. */
  edgeUrl: string;
  /** Loopback DSH origin, e.g. `http://127.0.0.1:PORT` (may carry an inline `?token=` for manual runs). */
  dshUrl: string;
  /**
   * 0600 JSON file `{ "url": "http://127.0.0.1:PORT/?token=..." }` written by
   * the DSH plugin. Takes precedence over `dshUrl`; keeps the launch token out
   * of argv. Contents are never logged.
   */
  dshUrlFile?: string;
  /** Display name shown in the dashboard. Defaults to the hostname. */
  name?: string;
  /** Directory for the device identity (created with mode 0700). */
  stateDir: string;
  /** Allow plain `http://`/`ws://` to a non-loopback edge and skip TLS verification. */
  insecure?: boolean;
  /** Explicit launch token; overrides a `token` query parameter on `dshUrl`. */
  dshToken?: string;
  /** Structured logger; defaults to a JSON-line logger on stdout/stderr. */
  logger?: Logger;
  /** Called on every status transition (and latency updates while online). */
  onStatus?: (status: AgentStatus) => void;
}

export interface AgentStatus {
  state: AgentState;
  deviceId?: string;
  pairUrl?: string;
  edgeUrl: string;
  latencyMs?: number;
  reconnects: number;
  lastError?: string;
  /** Epoch millis of the last state transition. */
  since: number;
  /** DSH origin only: never includes a launch token or cookie. */
  upstream: string;
}

export interface AgentHandle {
  status(): AgentStatus;
  /** Resolves once the tunnel is online; rejects on terminal failure or timeout. */
  waitForOnline(timeoutMs?: number): Promise<void>;
  /** Stop reconnecting, close the tunnel and release every timer. Idempotent. */
  stop(): Promise<void>;
}