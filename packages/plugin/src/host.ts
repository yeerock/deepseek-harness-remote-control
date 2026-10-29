/**
 * DSH host plugin: registers the `dsh-rc` service, resolves the loopback
 * origin plus the authenticated DSH URL, and supervises the tunnel agent as a
 * child process.
 *
 * Failure policy: `apply` never throws. A missing web server, an unbound port,
 * a broken agent entry, or a crashed child all surface as an `error` status
 * that the sidebar shows and the RPC channel reports. The Harness itself must
 * keep serving local work no matter what the remote-access plugin does.
 */

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';

import {
  AgentSupervisor,
  defaultPluginRoot,
} from './agent-supervisor.js';
import type { SupervisorLogger } from './agent-supervisor.js';
import {
  LOCALE_NAMESPACE,
  RPC_CHANNEL,
  rpcFail,
  rpcOk,
  SERVICE_NAME,
} from './contract.js';
import type { DshRcStatus, RpcReply } from './contract.js';
import { normalizeConfig, resolveDeviceName, resolveStateDir } from './config.js';
import type { PluginConfig } from './config.js';
import { SharingClient, sharingErrorCode } from './sharing.js';
import { buildJoinPrompt, isLoopbackOrigin, PLUGIN_VERSION } from './onboard.js';
import { UpdateManager } from './update.js';
import { buildTranscript, isSessionId } from './transcript.js';
import type { Transcript } from './transcript.js';
import { randomUUID } from 'node:crypto';
import { RemoteViewServer } from './remote-view.js';
import type { CreatedInvite, PeerList, SharingState } from './sharing.js';

/** Minimal structural view of the cordis context this plugin uses. */
interface LoggerLike {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

interface WebServerLike {
  getOrigin?: () => string;
  protocol?: string;
  host?: string;
  port?: number;
  register?: (route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => (() => void) | void;
  registerUpgrade?: (route: { path: string; handler: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void }) => (() => void) | void;
}

interface ConnectionLike {
  authenticatedUrl?: (baseUrl: string) => string;
  /**
   * Host/Origin + cookie/API-token admission. Returns an HTTP status when the
   * request must be rejected, or undefined when it is the authenticated owner.
   */
  requestRejection?: (request: unknown) => number | undefined;
}

interface CordisContextLike {
  logger?: LoggerLike;
  get?: (name: string) => unknown;
  provide?: (name: string, value: unknown) => unknown;
  effect?: (callback: () => unknown, label?: string) => unknown;
  [key: string]: unknown;
}

/**
 * Teardown of the previous plugin instance. Cordis re-applies this plugin when
 * `webServer`/`connection` reload; the old instance kills its agent and deletes
 * the credential file asynchronously, so the new instance must wait for that or
 * it races the old one (lost upstream file, held agent lock, agent never back).
 */
let previousTeardown: Promise<void> = Promise.resolve();

/** Public service face other host plugins can inject as `dsh-rc`. */
export interface DshRcServiceApi {
  status(): DshRcStatus;
  pairUrl(): string | undefined;
  start(): Promise<DshRcStatus>;
  restart(): Promise<DshRcStatus>;
  stop(): Promise<DshRcStatus>;
}

interface ServiceOptions {
  config: PluginConfig;
  deviceName: string;
  stateDir: string;
  pluginRoot: string;
  logger: SupervisorLogger;
  dshUrl: () => string;
  /** Rows from this Harness's own session catalog; empty when it is unavailable. */
  listSessions: () => Promise<unknown[]>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  history: (sessionId: string, maxMessages: number) => Promise<unknown[]>;
  sessions: SessionActions;
}

interface SessionActions {
  prompt(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  create(cwd: string): Promise<string>;
}

/** Plain view of one session, safe to hand to another Harness. */
export interface RemoteSessionRow {
  id: string;
  title: string;
  updatedAt: number | null;
  workspaceId: string;
  workspaceName: string;
}

const START_URL_WAIT_MS = 5_000;
const START_URL_POLL_MS = 250;

class DshRcService {
  readonly api: DshRcServiceApi;
  private readonly supervisor: AgentSupervisor;
  private readonly sharingClient: SharingClient;
  private readonly logger: SupervisorLogger;
  private readonly dshUrl: () => string;
  private readonly listSessions: () => Promise<unknown[]>;
  private readonly renameSession: (sessionId: string, title: string) => Promise<void>;
  private readonly history: (sessionId: string, maxMessages: number) => Promise<unknown[]>;
  private readonly sessions: SessionActions;
  private readonly stateDir: string;
  private readonly edgeUrl: string;
  private readonly updates: UpdateManager;
  private readonly remoteView: RemoteViewServer;
  private setupError: string | undefined;
  private hostEnabled: boolean;
  private ownName: string | undefined;

  constructor(options: ServiceOptions) {
    this.logger = options.logger;
    const saved = readHostSettings(options.stateDir);
    this.hostEnabled = saved.enabled;
    this.ownName = saved.name;
    this.dshUrl = options.dshUrl;
    this.listSessions = options.listSessions;
    this.renameSession = options.renameSession;
    this.history = options.history;
    this.sessions = options.sessions;
    this.stateDir = options.stateDir;
    this.edgeUrl = options.config.edgeUrl.replace(/\/+$/, '');
    this.updates = new UpdateManager({
      repoRoot: dirname(dirname(options.pluginRoot)),
      currentVersion: PLUGIN_VERSION,
      logger: options.logger,
    });
    this.updates.start();
    this.sharingClient = new SharingClient({
      stateDir: options.stateDir,
      edgeUrl: options.config.edgeUrl,
      logger: options.logger,
    });
    this.remoteView = new RemoteViewServer({
      edgeUrl: options.config.edgeUrl,
      mintTicket: (deviceId) => this.sharingClient.embedTicket(deviceId),
      logger: options.logger,
    });
    this.supervisor = new AgentSupervisor({
      config: options.config,
      dshUrl: options.dshUrl,
      deviceName: options.deviceName,
      stateDir: options.stateDir,
      pluginRoot: options.pluginRoot,
      logger: options.logger,
    });
    this.api = {
      status: () => this.status(),
      pairUrl: () => this.pairUrl(),
      start: () => this.start(),
      restart: () => this.restart(),
      stop: () => this.supervisor.stop(),
    };
  }

  /** Public edge origin from /v1/edge; independent of device auth. */
  async publicUrl(): Promise<string> {
    const response = await fetch(`${this.edgeUrl}/v1/edge`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`edge returned HTTP ${String(response.status)}`);
    const body = await response.json() as { publicUrl?: unknown };
    return typeof body.publicUrl === 'string' ? body.publicUrl : '';
  }

  embedTicket(deviceId: string): Promise<string> {
    return this.remoteView.embedUrl(deviceId);
  }

  /** This Harness's sessions grouped for a peer's sidebar (called over the edge). */
  async remoteList(): Promise<{ sessions: RemoteSessionRow[] }> {
    return { sessions: normalizeSessions(await this.listSessions()) };
  }

  /** Rename a computer (this one or a peer); this computer's own name is also kept locally. */
  async renameComputer(deviceId: string, name: string): Promise<{ id: string; name: string }> {
    const renamed = await this.sharingClient.renameDevice(deviceId, name);
    if (deviceId === this.supervisor.status().deviceId) {
      this.ownName = renamed.name;
      await writeHostSettings(this.stateDir, { enabled: this.hostEnabled, name: renamed.name });
    }
    return renamed;
  }

  /** Rename one of this computer's sessions (called over the edge by a peer, or locally). */
  async renameLocalSession(sessionId: string, title: string): Promise<{ ok: true }> {
    await this.renameSession(sessionId, title);
    return { ok: true };
  }

  /** This computer's session as a compact transcript (served to peers). */
  async localTranscript(sessionId: string): Promise<Transcript> {
    const [records, rows] = await Promise.all([this.history(sessionId, 80), this.listSessions()]);
    const row = rows.find((candidate) => isRecord(candidate) && candidate['sessionId'] === sessionId);
    const running = isRecord(row) && row['running'] === true;
    const title = normalizeSessions(row === undefined ? [] : [row])[0]?.title ?? '';
    return buildTranscript(records, { hasMore: false, running, title });
  }

  async localPrompt(sessionId: string, text: string): Promise<{ accepted: true }> {
    await this.sessions.prompt(sessionId, text);
    return { accepted: true };
  }

  async localCancel(sessionId: string): Promise<{ ok: true }> {
    await this.sessions.cancel(sessionId);
    return { ok: true };
  }

  /** New session in one of this computer's known workspaces (never an arbitrary path). */
  async localCreate(workspaceId: string): Promise<{ sessionId: string }> {
    const known = new Set(normalizeSessions(await this.listSessions()).map((row) => row.workspaceId));
    if (!known.has(workspaceId)) throw new Error('That workspace is not on this computer.');
    return { sessionId: await this.sessions.create(workspaceId) };
  }

  /** Forward one `remote.*` call to a peer Harness through the edge. */
  peerCall(deviceId: string, endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.remoteView.rpc(deviceId, endpoint, payload);
  }

  /** Rename a session that lives on a peer Harness. */
  async renameRemoteSession(deviceId: string, sessionId: string, title: string): Promise<{ ok: true }> {
    await this.remoteView.rpc(deviceId, 'remote.renameSession', { sessionId, title });
    return { ok: true };
  }

  /** A peer Harness's sessions, fetched through the edge. */
  async remoteSessions(deviceId: string): Promise<{ sessions: RemoteSessionRow[] }> {
    const value = await this.remoteView.rpc(deviceId, 'remote.list');
    const rows = isRecord(value) && Array.isArray(value['sessions']) ? value['sessions'] : [];
    return { sessions: normalizeSessions(rows) };
  }

  /**
   * Mint the one-time embed URL for a paired Harness. The plugin host runs in a
   * child process of the Electron main process, so it cannot create a native
   * BrowserWindow (`electron.BrowserWindow` is undefined here); the sidebar
   * opens the returned loopback URL itself. Refuse offline Harnesses up front
   * instead of opening a tab that can only say "Device offline".
   */
  async openRemoteWindow(deviceId: string, newSession: boolean, sessionId?: string): Promise<{ url: string; opened: boolean }> {
    const peer = (await this.sharingClient.listPeers()).peers.find((candidate) => candidate.id === deviceId);
    if (peer === undefined) throw new Error('That Harness is not paired with this edge any more.');
    if (!peer.online) {
      throw new Error(`${peer.name} is offline. Start DeepSeek Harness on that computer (its Remote Control agent must be running), then try again.`);
    }
    const url = await this.remoteView.embedUrl(deviceId);
    const query = newSession ? '?dsh-rc-new=1' : sessionId !== undefined && sessionId !== '' ? `?dsh-rc-session=${encodeURIComponent(sessionId)}` : '';
    return { url: `${url}${query}`, opened: false };
  }

  async harnessList(): Promise<PeerList> {
    const list = await this.sharingClient.listPeers();
    if (list.publicUrl === '') {
      try { list.publicUrl = await this.publicUrl(); } catch { /* keep empty */ }
    }
    return list;
  }

  /* ------------------------------ sharing ------------------------------ */

  sharingGet(): Promise<SharingState> {
    return this.sharingClient.getSharing();
  }

  sharingSet(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.sharingClient.setSharing(enabled);
  }

  sharingInvite(input: { label?: string; ttlSeconds?: number; maxUses?: number }): Promise<CreatedInvite> {
    return this.sharingClient.createInvite(input);
  }

  async sharingRevokeInvite(id: string): Promise<{ ok: true }> {
    await this.sharingClient.revokeInvite(id);
    return { ok: true };
  }

  async sharingDecide(id: string, decision: 'approve' | 'deny', ttlSeconds?: number): Promise<{ ok: true }> {
    await this.sharingClient.decideApproval(id, decision, ttlSeconds);
    return { ok: true };
  }

  async sharingRevokeGuest(sessionId: string): Promise<{ ok: true }> {
    await this.sharingClient.revokeGuest(sessionId);
    return { ok: true };
  }

  sharingRevokeAll(): Promise<{ revoked: number }> {
    return this.sharingClient.revokeAllGuests();
  }

  status(): DshRcStatus {
    const status = this.supervisor.status();
    status.version = PLUGIN_VERSION;
    status.hostEnabled = this.hostEnabled;
    if (this.ownName !== undefined) status.deviceName = this.ownName;
    const update = this.updates.getSnapshot();
    status.updateState = update.state;
    if (update.latest !== undefined) status.latestVersion = update.latest;
    if (update.message !== undefined) status.updateMessage = update.message;
    if (this.setupError !== undefined) status.lastError ??= this.setupError;
    return status;
  }

  pairUrl(): string | undefined {
    return this.supervisor.pairUrlValue();
  }

  /** Whether this computer is shared; read once at apply to decide auto-start. */
  isHostEnabled(): boolean {
    return this.hostEnabled;
  }

  /**
   * "Share This Computer" switch. Persists the choice (survives restarts) and
   * starts or stops the tunnel agent. Turning it off disconnects this computer
   * from the edge; its paired identity is kept, so turning it on is instant.
   */
  async setHostEnabled(enabled: boolean): Promise<DshRcStatus> {
    this.hostEnabled = enabled;
    await writeHostSettings(this.stateDir, { enabled, ...(this.ownName === undefined ? {} : { name: this.ownName }) });
    return enabled ? this.start() : this.supervisor.stop().then(() => this.status());
  }

  async start(): Promise<DshRcStatus> {
    await this.waitForDshUrl();
    return this.supervisor.start();
  }

  async restart(): Promise<DshRcStatus> {
    await this.waitForDshUrl();
    return this.supervisor.restart();
  }

  stop(): Promise<DshRcStatus> {
    return this.supervisor.stop();
  }

  dispose(): Promise<void> {
    this.remoteView.close();
    return this.supervisor.dispose();
  }

  failSetup(error: unknown): void {
    this.setupError = error instanceof Error ? error.message : String(error);
    this.logger.error('setup failed; service stays in error state', { message: this.setupError });
    // Durable breadcrumb: plugin-manager logs are often the only thing a user
    // can share, and the cordis logger may be buffered only.
    void mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      .then(() => writeFile(join(this.stateDir, 'plugin-error.json'), `${JSON.stringify({ at: Date.now(), message: this.setupError }, null, 2)}\n`, { mode: 0o600 }))
      .catch(() => undefined);
  }

  /**
   * The web server can apply before it binds a port. Wait briefly for
   * `getOrigin()` to succeed instead of failing the first auto-start.
   */
  private async waitForDshUrl(): Promise<void> {
    const deadline = Date.now() + START_URL_WAIT_MS;
    while (this.dshUrl() === '' && Date.now() < deadline) {
      await delay(START_URL_POLL_MS);
    }
  }
}

/* ------------------------------- plugin ------------------------------- */

/** Plugin display name; also the loader entry name in `cordis.patch.yml`. */
export const name = '@dsh-rc/plugin';

/**
 * Apply after the two services this plugin depends on exist. Cordis keeps the
 * fiber pending otherwise; nothing throws and no host code runs early.
 */
export const inject = ['webServer', 'connection', 'sessionController'];

/**
 * Register the `dsh-rc` service and wire auto-start.
 *
 * @param ctx cordis context (narrowed structurally so this package has no
 * `@deepseek-ai/cordis` dependency at build or install time).
 * @param rawConfig validated by {@link Config}; re-normalised defensively.
 */
export function apply(ctx: CordisContextLike, rawConfig?: unknown): void {
  const logger = createPluginLogger(ctx.logger);
  const { config, issues } = normalizeConfig(rawConfig);
  for (const issue of issues) logger.warn('config issue', { message: issue.message, path: issue.path.join('.') });

  const pluginRoot = defaultPluginRoot(import.meta.url);
  const deviceName = resolveDeviceName(config);
  const stateDir = resolveStateDir(config);

  const service = new DshRcService({
    config,
    deviceName,
    stateDir,
    pluginRoot,
    logger,
    dshUrl: () => resolveAuthenticatedUrl(ctx, logger),
    listSessions: () => listLocalSessions(ctx, logger),
    renameSession: (sessionId, title) => renameLocalSession(ctx, sessionId, title),
    history: (sessionId, maxMessages) => readSessionHistory(ctx, sessionId, maxMessages),
    sessions: {
      prompt: async (sessionId, text) => {
        const controller = sessionControllerOf(ctx);
        if (typeof controller.prompt !== 'function') throw new Error('This Harness cannot accept prompts right now.');
        await controller.prompt(
          { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
          AbortSignal.timeout(30_000),
        );
      },
      cancel: async (sessionId) => {
        const controller = sessionControllerOf(ctx);
        if (typeof controller.cancel !== 'function') throw new Error('This Harness cannot stop a turn right now.');
        await controller.cancel({ sessionId });
      },
      create: async (cwd) => {
        const controller = sessionControllerOf(ctx) as SessionControllerLike & { create?: (request: unknown) => Promise<unknown> };
        if (typeof controller.create !== 'function') throw new Error('This Harness cannot create sessions right now.');
        const created = await controller.create({ cwd });
        if (!isRecord(created) || typeof created['sessionId'] !== 'string') throw new Error('The new session was not created.');
        return created['sessionId'];
      },
    },
  });

  // Provide the service first: a later failure must leave a readable status,
  // not an unregistered name with a crashed fiber.
  try {
    if (typeof ctx.provide !== 'function') throw new Error('cordis context has no provide()');
    ctx.provide(SERVICE_NAME, service.api);
  } catch (error) {
    logger.error('could not register the dsh-rc service', { message: messageOf(error) });
  }

  const waitFor = previousTeardown;
  let disposeRpc: (() => void) | undefined;
  try {
    disposeRpc = registerRpcChannel(ctx, service, logger);
  } catch (error) {
    service.failSetup(error);
  }


  try {
    ctx.effect?.(
      () => () => {
        try {
          disposeRpc?.();
        } catch {
          /* already torn down with the fiber */
        }
        previousTeardown = service.dispose().catch(() => undefined);
      },
      'dsh-rc: agent supervisor lifecycle',
    );
  } catch (error) {
    logger.warn('could not attach lifecycle disposer', { message: messageOf(error) });
  }

  logger.info('service registered', {
    enabled: config.enabled,
    autoStart: config.autoStart,
    edgeUrl: config.edgeUrl,
    deviceName,
    stateDir,
    locale: LOCALE_NAMESPACE,
  });

  if (config.enabled && config.autoStart && service.isHostEnabled()) {
    // Never make boot wait on a child process.
    queueMicrotask(() => {
      void waitFor.then(() => service.start()).catch((error: unknown) => {
        logger.error('auto-start failed', { message: messageOf(error) });
      });
    });
  }
}

/* -------------------------------- RPC -------------------------------- */

/**
 * Set by our agent on every request it relays from the edge (HTTP and WS).
 * endpointOf() matches case and encoding exactly, never more loosely than the
 * edge's guest guard (isHostPluginPath), so the two cannot disagree in a way
 * that admits a call.
 */
const VIA_EDGE_HEADER = 'x-dsh-rc-via';
const PEER_ENDPOINTS = new Set([
  'status',
  'harness.list',
  'remote.list',
  'remote.history',
  'remote.prompt',
  'remote.cancel',
  'remote.create',
  'remote.renameSession',
]);

/** Response cap for control requests; the browser never sends more. */
const MAX_RPC_BODY_BYTES = 256 * 1024;
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/**
 * Register the authenticated `/dsh-rc` RPC prefix.
 *
 * This is deliberately a plain webServer prefix route rather than
 * `connection.rpc.handle()`: the service-side helper resolves `webServer`
 * against the *connection* fiber's context, which does not inject it, and
 * throws `cannot get property "webServer" without inject`. Registering the
 * route from this plugin's context (where both services are injected) keeps
 * the same wire contract while staying composable.
 *
 * @returns disposer releasing the route.
 */
function registerRpcChannel(
  ctx: CordisContextLike,
  service: DshRcService,
  logger: SupervisorLogger,
): () => void {
  const webServer = getService<WebServerLike>(ctx, 'webServer');
  if (webServer === undefined || typeof webServer.register !== 'function') {
    throw new Error('webServer service is unavailable; the status UI will report the host as unreachable');
  }
  const connection = getService<ConnectionLike>(ctx, 'connection');
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    throw new Error('connection service cannot admit requests; the status UI will report the host as unreachable');
  }
  const handler = (request: IncomingMessage, response: ServerResponse): Promise<void> =>
    handleRpcRequest(connection, service, request, response);
  const dispose = webServer.register({ kind: 'prefix', path: RPC_CHANNEL, handler });
  logger.info('rpc channel registered', { channel: RPC_CHANNEL, kind: 'prefix' });
  return typeof dispose === 'function' ? dispose : () => undefined;
}

/** One POST `<channel>/<endpoint>` with the Connection RPC JSON envelope. */
async function handleRpcRequest(
  connection: ConnectionLike,
  service: DshRcService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const rejection = connection.requestRejection?.(request);
  if (rejection !== undefined) {
    response.writeHead(rejection);
    response.end(rejection === 401 ? 'unauthorized' : 'forbidden');
    return;
  }

  const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname;
  const endpoint = endpointOf(pathname);
  // Requests relayed by our agent (another computer, or a browser through the
  // edge) get only read-only status and the session endpoints. Switches,
  // sharing, renames and calls that reach onward to other computers stay with
  // the local window.
  if (request.headers[VIA_EDGE_HEADER] !== undefined && (endpoint === undefined || !PEER_ENDPOINTS.has(endpoint))) {
    writeRpcText(response, 403, 'not available over the edge');
    return;
  }
  if (request.method !== 'POST' || endpoint === undefined) {
    writeRpcText(response, 404, 'not found');
    return;
  }
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    writeRpcText(response, 415, 'content type must be application/json');
    return;
  }
  const body = await readBody(request);
  if (body === undefined) {
    writeRpcText(response, 400, 'body is not JSON');
    return;
  }
  const envelope = body as Record<string, unknown>;
  const rpcId = typeof envelope['rpcId'] === 'string' ? envelope['rpcId'] : 'invalid-request';
  if (envelope['type'] !== 'client-request' || typeof envelope['method'] !== 'string') {
    writeRpcJson(response, 400, {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request envelope' } },
    });
    return;
  }
  if (envelope['method'] !== endpoint) {
    writeRpcJson(response, 200, {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'gateway/bad-request', message: `method does not match endpoint ${JSON.stringify(endpoint)}` } },
    });
    return;
  }

  const result = await dispatchEndpoint(service, endpoint, envelope['payload']);
  writeRpcJson(response, 200, { type: 'server-response', rpcId, result });
}

/** Narrow view of the service the RPC dispatcher needs; exported for tests. */
export interface SharingRpcTarget {
  status(): DshRcStatus;
  start(): Promise<DshRcStatus>;
  restart(): Promise<DshRcStatus>;
  stop(): Promise<DshRcStatus>;
  pairUrl(): string | undefined;
  sharingGet(): Promise<SharingState>;
  publicUrl(): Promise<string>;
  harnessList(): Promise<PeerList>;
  embedTicket(deviceId: string): Promise<string>;
  openRemoteWindow(deviceId: string, newSession: boolean, sessionId?: string): Promise<{ url: string; opened: boolean }>;
  setHostEnabled(enabled: boolean): Promise<DshRcStatus>;
  localTranscript(sessionId: string): Promise<Transcript>;
  localPrompt(sessionId: string, text: string): Promise<{ accepted: true }>;
  localCancel(sessionId: string): Promise<{ ok: true }>;
  localCreate(workspaceId: string): Promise<{ sessionId: string }>;
  peerCall(deviceId: string, endpoint: string, payload: Record<string, unknown>): Promise<unknown>;
  renameComputer(deviceId: string, name: string): Promise<{ id: string; name: string }>;
  renameLocalSession(sessionId: string, title: string): Promise<{ ok: true }>;
  renameRemoteSession(deviceId: string, sessionId: string, title: string): Promise<{ ok: true }>;
  remoteList(): Promise<{ sessions: RemoteSessionRow[] }>;
  remoteSessions(deviceId: string): Promise<{ sessions: RemoteSessionRow[] }>;
  sharingSet(enabled: boolean): Promise<{ enabled: boolean }>;
  sharingInvite(input: { label?: string; ttlSeconds?: number; maxUses?: number }): Promise<CreatedInvite>;
  sharingRevokeInvite(id: string): Promise<{ ok: true }>;
  sharingDecide(id: string, decision: 'approve' | 'deny', ttlSeconds?: number): Promise<{ ok: true }>;
  sharingRevokeGuest(sessionId: string): Promise<{ ok: true }>;
  sharingRevokeAll(): Promise<{ revoked: number }>;
}

/**
 * Dispatch one RPC endpoint. Exported so the request/response shapes can be
 * unit-tested without a live cordis context.
 */
export async function dispatchEndpoint(target: SharingRpcTarget, endpoint: string, payload?: unknown): Promise<RpcReply<unknown>> {
  const input = isRecord(payload) ? payload : {};
  try {
    switch (endpoint) {
      case 'status':
        return rpcOk(target.status());
      case 'start':
        return rpcOk(await target.start());
      case 'restart':
        return rpcOk(await target.restart());
      case 'stop':
        return rpcOk(await target.stop());
      case 'pair-url':
        return rpcOk({ pairUrl: target.pairUrl() ?? null });
      case 'harness.list':
        return rpcOk(await target.harnessList());
      case 'remote.embed': {
        const deviceId = typeof input['deviceId'] === 'string' ? input['deviceId'] : '';
        if (deviceId === '') return rpcFail('bad-request', 'deviceId is required.');
        const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : undefined;
        return rpcOk(await target.openRemoteWindow(deviceId, input['newSession'] === true, sessionId));
      }
      case 'host.set': {
        if (typeof input['enabled'] !== 'boolean') return rpcFail('bad-request', 'enabled must be a boolean.');
        return rpcOk(await target.setHostEnabled(input['enabled']));
      }
      case 'computer.rename': {
        const deviceId = typeof input['deviceId'] === 'string' ? input['deviceId'] : '';
        const name = typeof input['name'] === 'string' ? input['name'].trim() : '';
        if (deviceId === '' || name === '') return rpcFail('bad-request', 'deviceId and name are required.');
        return rpcOk(await target.renameComputer(deviceId, name));
      }
      case 'remote.renameSession': {
        const sessionId = input['sessionId'];
        const title = typeof input['title'] === 'string' ? input['title'].trim() : '';
        if (!isSessionId(sessionId) || title === '' || title.length > 200) return rpcFail('bad-request', 'sessionId and a 1-200 character title are required.');
        return rpcOk(await target.renameLocalSession(sessionId, title));
      }
      case 'session.rename': {
        const deviceId = typeof input['deviceId'] === 'string' ? input['deviceId'] : '';
        const sessionId = input['sessionId'];
        const title = typeof input['title'] === 'string' ? input['title'].trim() : '';
        if (deviceId === '' || !isSessionId(sessionId) || title === '' || title.length > 200) return rpcFail('bad-request', 'deviceId, sessionId and a 1-200 character title are required.');
        return rpcOk(await target.renameRemoteSession(deviceId, sessionId, title));
      }
      /* Served to peers (over the edge) about this computer's own sessions. */
      case 'remote.history': {
        if (!isSessionId(input['sessionId'])) return rpcFail('bad-request', 'sessionId is invalid.');
        return rpcOk(await target.localTranscript(input['sessionId']));
      }
      case 'remote.prompt': {
        if (!isSessionId(input['sessionId'])) return rpcFail('bad-request', 'sessionId is invalid.');
        const text = typeof input['text'] === 'string' ? input['text'] : '';
        if (text.trim() === '' || text.length > 100_000) return rpcFail('bad-request', 'text must be 1-100000 characters.');
        return rpcOk(await target.localPrompt(input['sessionId'], text));
      }
      case 'remote.cancel': {
        if (!isSessionId(input['sessionId'])) return rpcFail('bad-request', 'sessionId is invalid.');
        return rpcOk(await target.localCancel(input['sessionId']));
      }
      case 'remote.create': {
        const workspace = typeof input['workspaceId'] === 'string' ? input['workspaceId'] : '';
        return rpcOk(await target.localCreate(workspace));
      }
      /* Called by this computer's own UI about a peer's session. */
      case 'session.history':
      case 'session.prompt':
      case 'session.cancel':
      case 'session.create': {
        const deviceId = typeof input['deviceId'] === 'string' ? input['deviceId'] : '';
        if (deviceId === '') return rpcFail('bad-request', 'deviceId is required.');
        const { deviceId: _omit, ...rest } = input;
        void _omit;
        return rpcOk(await target.peerCall(deviceId, `remote.${endpoint.slice('session.'.length)}`, rest));
      }
      case 'remote.list':
        return rpcOk(await target.remoteList());
      case 'remote.sessions': {
        const deviceId = typeof input['deviceId'] === 'string' ? input['deviceId'] : '';
        if (deviceId === '') return rpcFail('bad-request', 'deviceId is required.');
        return rpcOk(await target.remoteSessions(deviceId));
      }
      case 'sharing.get':
        return rpcOk(await target.sharingGet());
      case 'sharing.set': {
        const enabled = input['enabled'];
        if (typeof enabled !== 'boolean') return rpcFail('bad-request', 'enabled must be a boolean.');
        return rpcOk(await target.sharingSet(enabled));
      }
      case 'sharing.invite': {
        const label = typeof input['label'] === 'string' ? input['label'] : undefined;
        const ttlSeconds = typeof input['ttlSeconds'] === 'number' ? input['ttlSeconds'] : undefined;
        const maxUses = typeof input['maxUses'] === 'number' ? input['maxUses'] : undefined;
        return rpcOk(
          await target.sharingInvite({
            ...(label === undefined ? {} : { label }),
            ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
            ...(maxUses === undefined ? {} : { maxUses }),
          }),
        );
      }
      case 'sharing.revokeInvite': {
        const id = typeof input['id'] === 'string' ? input['id'] : '';
        if (id === '') return rpcFail('bad-request', 'id is required.');
        return rpcOk(await target.sharingRevokeInvite(id));
      }
      case 'sharing.decide': {
        const id = typeof input['id'] === 'string' ? input['id'] : '';
        const decision = input['decision'];
        if (id === '') return rpcFail('bad-request', 'id is required.');
        if (decision !== 'approve' && decision !== 'deny') return rpcFail('bad-request', 'decision must be approve or deny.');
        const ttlSeconds = typeof input['ttlSeconds'] === 'number' ? input['ttlSeconds'] : undefined;
        return rpcOk(await target.sharingDecide(id, decision, ttlSeconds));
      }
      case 'sharing.revokeGuest': {
        const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : '';
        if (sessionId === '') return rpcFail('bad-request', 'sessionId is required.');
        return rpcOk(await target.sharingRevokeGuest(sessionId));
      }
      case 'sharing.revokeAll':
        return rpcOk(await target.sharingRevokeAll());
      case 'sharing.joinPrompt': {
        const publicUrl = await target.publicUrl();
        if (publicUrl === '' || isLoopbackOrigin(publicUrl)) {
          return rpcOk({ prompt: null, reason: 'public-url-required' });
        }
        return rpcOk({ prompt: buildJoinPrompt({ publicUrl, version: PLUGIN_VERSION }) });
      }
      default:
        return rpcFail('not-found', `unknown dsh-rc endpoint ${JSON.stringify(endpoint)}`);
    }
  } catch (error) {
    return rpcFail(sharingErrorCode(error), messageOf(error));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointOf(pathname: string): string | undefined {
  const prefix = `${RPC_CHANNEL}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest === '') return undefined;
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || !ENDPOINT_PATTERN.test(segment)) return undefined;
  }
  return rest;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_RPC_BODY_BYTES) {
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function writeRpcJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function writeRpcText(response: ServerResponse, status: number, body: string): void {
  const payload = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/* ------------------------------ helpers ------------------------------ */

/**
 * Loopback origin + launch token: what the agent exchanges for its DSH cookie.
 *
 * @returns the authenticated URL, or `''` while the web server is unbound or
 * the connection service cannot mint one. The caller retries briefly.
 */
function resolveAuthenticatedUrl(ctx: CordisContextLike, logger: SupervisorLogger): string {
  try {
    const webServer = getService<WebServerLike>(ctx, 'webServer');
    const origin = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : '';
    if (origin === '') return '';
    const base = `${origin.replace(/\/+$/, '')}/`;
    const connection = getService<ConnectionLike>(ctx, 'connection');
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return base;
    return connection.authenticatedUrl(base);
  } catch (error) {
    logger.debug('authenticated URL not ready', { message: messageOf(error) });
    return '';
  }
}

interface HostSettings {
  /** "Share This Computer"; a missing file means shared, the default after pairing. */
  enabled: boolean;
  /** Name the user gave this computer; overrides the configured device name. */
  name?: string;
}

function readHostSettings(stateDir: string): HostSettings {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'host.json'), 'utf8')) as { enabled?: unknown; name?: unknown };
    return {
      enabled: parsed.enabled !== false,
      ...(typeof parsed.name === 'string' && parsed.name.trim() !== '' ? { name: parsed.name.trim() } : {}),
    };
  } catch {
    return { enabled: true };
  }
}

async function writeHostSettings(stateDir: string, settings: HostSettings): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, 'host.json'), `${JSON.stringify(settings)}\n`, { mode: 0o600 });
}

interface SessionControllerLike {
  list?: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
  rename?: (request: unknown) => Promise<unknown>;
  page?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  projections?: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
  prompt?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  cancel?: (request: unknown) => Promise<unknown>;
}

function sessionControllerOf(ctx: CordisContextLike): SessionControllerLike {
  const controller = getService<SessionControllerLike>(ctx, 'sessionController');
  if (controller === undefined) throw new Error('This Harness cannot read sessions right now.');
  return controller;
}

/** Raw history records of one session (newest page), for a peer's conversation view. */
async function readSessionHistory(ctx: CordisContextLike, sessionId: string, maxMessages: number): Promise<unknown[]> {
  const controller = sessionControllerOf(ctx);
  if (typeof controller.page !== 'function') throw new Error('This Harness cannot read session history.');
  let throughSeq = Number.MAX_SAFE_INTEGER;
  try {
    const projections = await controller.projections?.({ sessionId }, AbortSignal.timeout(10_000));
    if (isRecord(projections) && typeof projections['asOfSeq'] === 'number') throughSeq = projections['asOfSeq'];
  } catch { /* fall back to the open-ended cut */ }
  const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq, maxMessages }, AbortSignal.timeout(20_000));
  return isRecord(page) && Array.isArray(page['records']) ? page['records'] : [];
}

async function renameLocalSession(ctx: CordisContextLike, sessionId: string, title: string): Promise<void> {
  const controller = getService<{ rename?: (request: unknown) => Promise<unknown> }>(ctx, 'sessionController');
  if (typeof controller?.rename !== 'function') throw new Error('This Harness cannot rename sessions right now.');
  await controller.rename({ sessionId, title });
}

/** Rows from this Harness's session catalog, or `[]` when the controller is not ready. */
async function listLocalSessions(ctx: CordisContextLike, logger: SupervisorLogger): Promise<unknown[]> {
  try {
    const controller = getService<{ list?: (request: unknown, signal?: AbortSignal) => Promise<unknown> }>(ctx, 'sessionController');
    if (typeof controller?.list !== 'function') return [];
    const result = await controller.list({}, AbortSignal.timeout(10_000));
    const items = isRecord(result) ? result['items'] : result;
    return Array.isArray(items) ? items : [];
  } catch (error) {
    logger.warn('session list unavailable', { message: messageOf(error) });
    return [];
  }
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function pickTime(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/** First non-empty `title` string inside a projection tree (bounded depth). */
function findTitle(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTitle(entry, depth + 1);
      if (found !== '') return found;
    }
    return '';
  }
  const record = value as Record<string, unknown>;
  const direct = record['title'];
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  for (const key of Object.keys(record)) {
    const found = findTitle(record[key], depth + 1);
    if (found !== '') return found;
  }
  return '';
}

/** Reduce raw catalog rows to the few plain fields a peer needs; drops archived rows. */
export function normalizeSessions(rows: unknown[]): RemoteSessionRow[] {
  const out: RemoteSessionRow[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const id = pickString(raw, ['sessionId', 'id']);
    if (id === '' || raw['archived'] === true || raw['archivedAt'] != null || raw['blank'] === true) continue;
    const workspace = isRecord(raw['workspace']) ? raw['workspace'] : {};
    const directory = pickString(raw, ['directory', 'cwd', 'workspacePath', 'path']) || pickString(workspace, ['directory', 'path']);
    const workspaceId = pickString(raw, ['workspaceId']) || pickString(workspace, ['id', 'workspaceId']) || directory;
    const workspaceName =
      pickString(raw, ['workspaceName', 'workspaceTitle']) ||
      pickString(workspace, ['name', 'title']) ||
      (directory === '' ? 'Workspace' : directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'Workspace');
    out.push({
      id,
      title: pickString(raw, ['title', 'name', 'summary']) || findTitle(raw['projections']) || 'Untitled session',
      updatedAt: pickTime(raw, ['updatedAt', 'lastActivityAt', 'lastMessageAt', 'modifiedAt', 'createdAt']),
      workspaceId,
      workspaceName,
    });
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out.slice(0, 200);
}

function getService<T>(ctx: CordisContextLike, name: string): T | undefined {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    if (viaGet !== undefined && viaGet !== null) return viaGet as T;
  } catch {
    /* fall through to the direct property */
  }
  const direct = ctx[name];
  return (direct as T | undefined) ?? undefined;
}

/** Cordis logger → the small JSON-friendly face the supervisor wants. */
export function createPluginLogger(base: LoggerLike | undefined): SupervisorLogger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void => {
    const text = fields === undefined ? `dsh-rc: ${message}` : `dsh-rc: ${message} ${JSON.stringify(redactFields(fields))}`;
    try {
      const fn = base?.[level] ?? base?.info;
      fn?.(text);
    } catch {
      /* a logger failure must never break the plugin */
    }
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

const REDACTED_KEYS = /(token|secret|cookie|authorization|dshurl|password)/i;

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACTED_KEYS.test(key) ? '[redacted]' : value;
  }
  return out;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms).unref?.();
  });
}