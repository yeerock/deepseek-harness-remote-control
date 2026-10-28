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

import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

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
import type { CreatedInvite, SharingState } from './sharing.js';

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
}

const START_URL_WAIT_MS = 5_000;
const START_URL_POLL_MS = 250;

class DshRcService {
  readonly api: DshRcServiceApi;
  private readonly supervisor: AgentSupervisor;
  private readonly sharingClient: SharingClient;
  private readonly logger: SupervisorLogger;
  private readonly dshUrl: () => string;
  private readonly stateDir: string;
  private readonly edgeUrl: string;
  private setupError: string | undefined;

  constructor(options: ServiceOptions) {
    this.logger = options.logger;
    this.dshUrl = options.dshUrl;
    this.stateDir = options.stateDir;
    this.edgeUrl = options.config.edgeUrl.replace(/\/+$/, '');
    this.sharingClient = new SharingClient({
      stateDir: options.stateDir,
      edgeUrl: options.config.edgeUrl,
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
    if (this.setupError !== undefined) status.lastError ??= this.setupError;
    return status;
  }

  pairUrl(): string | undefined {
    return this.supervisor.pairUrlValue();
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
export const inject = ['webServer', 'connection'];

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
  });

  // Provide the service first: a later failure must leave a readable status,
  // not an unregistered name with a crashed fiber.
  try {
    if (typeof ctx.provide !== 'function') throw new Error('cordis context has no provide()');
    ctx.provide(SERVICE_NAME, service.api);
  } catch (error) {
    logger.error('could not register the dsh-rc service', { message: messageOf(error) });
  }

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
        void service.dispose();
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

  if (config.enabled && config.autoStart) {
    // Never make boot wait on a child process.
    queueMicrotask(() => {
      void service.start().catch((error: unknown) => {
        logger.error('auto-start failed', { message: messageOf(error) });
      });
    });
  }
}

/* -------------------------------- RPC -------------------------------- */

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