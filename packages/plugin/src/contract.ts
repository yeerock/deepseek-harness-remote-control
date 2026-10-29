/**
 * Types shared by the host plugin and its browser half.
 *
 * `AgentStatus` mirrors the contract in `apps/agent/src/index.ts` (task-2). It
 * is duplicated rather than imported so this package typechecks and bundles
 * before the agent lands and so the plugin has no runtime dependency on it.
 * The wire format that matters is the JSON status file the agent writes and
 * the terminal state string; both are validated and normalised on read.
 */

/** Terminal / lifecycle states a DSH RC agent reports. */
export const AGENT_STATES = [
  'starting',
  'pairing',
  'connecting',
  'online',
  'reconnecting',
  'error',
  'stopped',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);
}

/**
 * The subset of the agent's `AgentStatus` the plugin consumes. Every field is
 * optional because a status file can be read mid-write or come from an older
 * agent; the supervisor normalises what it reads.
 */
export interface AgentStatus {
  state: AgentState;
  deviceId?: string;
  pairUrl?: string;
  edgeUrl?: string;
  latencyMs?: number;
  reconnects: number;
  lastError?: string;
  since: number;
  upstream?: string;
}

/** What the sidebar and the RPC channel see. */
export interface DshRcStatus extends AgentStatus {
  /** Config switch: whether the plugin is allowed to auto-start the agent. */
  enabled: boolean;
  /** Config switch: start on plugin apply (only when `enabled`). */
  autoStart: boolean;
  deviceName: string;
  /**
   * "Share This Computer": whether this computer accepts remote access from
   * the owner's other computers. Persisted per state dir; on by default.
   */
  hostEnabled?: boolean;
  /** True while a child process is alive. */
  agentRunning: boolean;
  /** Resolved launch target, for troubleshooting copy. */
  agentEntry?: string;
  pid?: number;
  /** Supervisor restarts since the plugin applied. */
  restarts: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
  stateDir: string;
  /** Plugin package version. */
  version?: string;
  latestVersion?: string;
  updateState?: string;
  updateMessage?: string;
}

/** RPC reply envelope expected by `ctx.connection.rpc.call` on the client. */
export type RpcReply<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export function rpcOk<T>(value: T): RpcReply<T> {
  return { ok: true, value };
}

export function rpcFail(code: string, message: string): RpcReply<never> {
  return { ok: false, error: { code, message } };
}

/** Browser-visible RPC channel; the client posts `<channel>/<endpoint>`. */
export const RPC_CHANNEL = '/dsh-rc';

export type RpcEndpoint =
  | 'status'
  | 'start'
  | 'restart'
  | 'stop'
  | 'pair-url'
  | 'sharing.get'
  | 'sharing.set'
  | 'sharing.invite'
  | 'sharing.revokeInvite'
  | 'sharing.decide'
  | 'sharing.revokeGuest'
  | 'sharing.revokeAll';

/** Locale namespace used by the host locale files and the client dictionaries. */
export const LOCALE_NAMESPACE = 'dsh-rc';

/** Service name other host plugins can inject to read/steer the agent. */
export const SERVICE_NAME = 'dsh-rc';