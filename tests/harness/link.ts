/**
 * Integration harness: real edge process + real agent (in-process) + mock DSH.
 *
 * Nothing here re-implements the tunnel. The agent is started through its
 * public `startAgent()` API, the edge through its CLI, and requests are made
 * with plain HTTP so the assertions describe the product surface a browser and
 * a device actually see.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import type * as NodeSqlite from 'node:sqlite';

// Vite 2.1 does not know `node:sqlite` as a builtin, so a static runtime import
// breaks every test file. Resolve it through Node's own builtin registry, with
// the static import kept type-only (erased at compile/test-transform time).
const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;
import { MockDsh, startMockDsh } from '../fixtures/mock-dsh.js';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/* ------------------------------------------------------------------ */
/* Timing helpers — polling with deadlines, never fixed long sleeps.   */
/* ------------------------------------------------------------------ */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/** Poll `probe` until it returns a truthy value; throws with context on timeout. */
export async function waitFor<T>(
  probe: () => T | Promise<T | undefined | false>,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 10;
  const label = options.label ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError === undefined ? '' : ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}${suffix}`);
}

/* ------------------------------------------------------------------ */
/* Cookie jar (name/value only; enough for tests).                     */
/* ------------------------------------------------------------------ */

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(setCookieHeaders: readonly string[]): void {
    for (const header of setCookieHeaders) this.absorbOne(header);
  }

  absorbOne(header: string): void {
    const [pair] = header.split(';');
    if (pair === undefined) return;
    const equals = pair.indexOf('=');
    if (equals <= 0) return;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (value === '' || /max-age=0/i.test(header)) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }

  /** Cookie header value, or undefined when the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [name, value] of this.cookies) copy.cookies.set(name, value);
    return copy;
  }
}

/* ------------------------------------------------------------------ */
/* Raw HTTP (no URL normalisation, no redirect following).             */
/* ------------------------------------------------------------------ */

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  setCookies: string[];
  body: Buffer;
  bodyText: string;
}

export interface RawRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

/**
 * Send an origin-form request exactly as written. `fetch()` normalises `..`
 * segments before they reach the wire, so path-safety tests need this.
 */
export async function rawRequest(baseUrl: string, options: RawRequestOptions): Promise<RawResponse> {
  const url = new URL(baseUrl);
  const headers = { ...options.headers };
  const payload = options.body === undefined
    ? undefined
    : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf8');
  if (payload !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(payload.byteLength);
  }
  return await new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port === '' ? 80 : Number(url.port),
      method: options.method ?? 'GET',
      path: options.path,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          setCookies: collectSetCookies(res.headers),
          body,
          bodyText: body.toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.setTimeout(options.timeoutMs ?? 10_000, () => {
      req.destroy(new Error('raw request timeout'));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function collectSetCookies(headers: Record<string, string | string[] | undefined>): string[] {
  const raw = headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/* ------------------------------------------------------------------ */
/* Edge process                                                        */
/* ------------------------------------------------------------------ */

export interface EdgeProcess {
  url: string;
  port: number;
  child: ChildProcessWithoutNullStreams;
  output(): string;
  stop(): Promise<void>;
}

const EDGE_ENTRY = join(REPO_ROOT, 'apps', 'edge', 'src', 'main.ts');

export interface StartEdgeOptions {
  dataDir: string;
  setupCode: string;
  /** Reuse a specific port (edge-restart tests); 0/undefined picks an ephemeral one. */
  port?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/** Boot `apps/edge/src/main.ts` on an ephemeral loopback port. */
export async function startEdge(options: StartEdgeOptions): Promise<EdgeProcess> {
  const args = [
    '--import', 'tsx',
    EDGE_ENTRY,
    '--host', '127.0.0.1',
    '--port', String(options.port ?? 0),
    '--data-dir', options.dataDir,
    '--setup-code', options.setupCode,
    '--insecure',
    '--log-level', 'silent',
    ...(options.extraArgs ?? []),
  ];
  let output = '';
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSHRC_SETUP_CODE: options.setupCode,
      NO_COLOR: '1',
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { output += chunk; });

  let exitError: Error | undefined;
  child.once('exit', (code, signal) => {
    exitError = new Error(`edge exited early (code=${String(code)}, signal=${String(signal)})\n${output.slice(-4000)}`);
  });

  const ready = async (): Promise<EdgeProcess | undefined> => {
    // Contract: "DSH RC edge listening on http://127.0.0.1:<port>".
    const match = /listening on http:\/\/127\.0\.0\.1:(\d{1,5})/.exec(output)
      ?? /http:\/\/127\.0\.0\.1:(\d{1,5})/.exec(output)
      ?? /"port"\s*:\s*(\d{1,5})/.exec(output);
    if (match === null) {
      if (exitError !== undefined) throw exitError;
      return undefined;
    }
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port <= 0) return undefined;
    try {
      const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (health.status !== 200) return undefined;
    } catch {
      return undefined;
    }
    return {
      url: `http://127.0.0.1:${String(port)}`,
      port,
      child,
      output: () => output,
      async stop() {
        await stopChild(child);
      },
    };
  };

  return await waitFor(ready, { timeoutMs: 15_000, intervalMs: 25, label: `edge boot and /healthz (${EDGE_ENTRY})` });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(3000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(1000),
    ]);
  }
}

/* ------------------------------------------------------------------ */
/* Agent (public API, loaded dynamically so missing code is loud)      */
/* ------------------------------------------------------------------ */

export interface AgentStatusLike {
  state: string;
  deviceId?: string;
  pairUrl?: string;
  edgeUrl: string;
  reconnects: number;
  lastError?: string;
  upstream: string;
}

export interface AgentHandleLike {
  status(): AgentStatusLike;
  waitForOnline(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentModuleLike {
  startAgent(options: Record<string, unknown>): Promise<AgentHandleLike>;
}

const AGENT_ENTRY = join(REPO_ROOT, 'apps', 'agent', 'src', 'index.ts');

export async function loadAgentModule(): Promise<AgentModuleLike> {
  try {
    return await import(AGENT_ENTRY) as AgentModuleLike;
  } catch (error) {
    throw new Error(
      `apps/agent/src/index.ts is missing or does not export startAgent (agent-engineer task-2 not landed?). `
      + `Repro: ls ${AGENT_ENTRY}. Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Owner auth (setup), device approval and browser pairing             */
/* ------------------------------------------------------------------ */

export interface OwnerSession {
  jar: CookieJar;
  csrfToken: string | undefined;
  cookieHeader: string | undefined;
  /** Password supplied to POST /setup, if any (used by the anonymous pair path). */
  password?: string;
}

function extractCsrf(html: string): string | undefined {
  const input = /name=["'](?:_?csrf(?:Token)?|csrf_token)["'][^>]*value=["']([^"']+)["']/i.exec(html);
  if (input !== null) return input[1];
  const meta = /name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (meta !== null) return meta[1];
  const json = /"(?:csrf|csrfToken)"\s*:\s*"([^"]+)"/.exec(html);
  return json?.[1];
}

function csrfFromJar(jar: CookieJar): string | undefined {
  for (const name of jar.names()) {
    if (/csrf/i.test(name)) return jar.get(name);
  }
  return undefined;
}

/**
 * Complete first-run owner setup. The exact cookie and field names are read
 * from the server's own response rather than hard-coded, so this harness
 * survives a rename that does not change the flow.
 */
export async function ownerSetup(edgeUrl: string, setupCode: string, password?: string): Promise<OwnerSession> {
  const jar = new CookieJar();
  const page = await rawRequest(edgeUrl, {
    path: '/setup',
    headers: { accept: 'text/html' },
  });
  jar.absorb(page.setCookies);
  const csrfToken = extractCsrf(page.bodyText) ?? csrfFromJar(jar);
  const form = new URLSearchParams();
  // Contract: POST /setup form fields are `code`, `csrf` and optional `password`.
  form.set('code', setupCode);
  if (csrfToken !== undefined) form.set('csrf', csrfToken);
  if (password !== undefined) form.set('password', password);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: edgeUrl,
    accept: 'text/html,application/json',
    cookie: jar.header() ?? '',
  };
  if (csrfToken !== undefined) headers['x-csrf-token'] = csrfToken;
  const response = await rawRequest(edgeUrl, { method: 'POST', path: '/setup', headers, body: form.toString() });
  jar.absorb(response.setCookies);
  if (response.status >= 400) {
    throw new Error(`owner setup failed: HTTP ${String(response.status)} ${response.bodyText.slice(0, 500)}`);
  }
  return {
    jar,
    csrfToken: csrfToken ?? csrfFromJar(jar),
    cookieHeader: jar.header(),
    ...(password === undefined ? {} : { password }),
  };
}

/** Extract the 8-char pair code from the agent's advertised pair URL. */
export function pairCodeFromUrl(pairUrl: string | undefined): string | undefined {
  if (pairUrl === undefined) return undefined;
  try {
    const url = new URL(pairUrl);
    const fromQuery = url.searchParams.get('code') ?? url.searchParams.get('pair');
    if (fromQuery !== null && fromQuery !== undefined && fromQuery !== '') return fromQuery;
    const last = url.pathname.split('/').filter(Boolean).at(-1);
    if (last !== undefined && /^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(last)) return last;
  } catch {
    /* not a URL: fall through to regex */
  }
  const match = /([a-z0-9]{4}-[a-z0-9]{4})/i.exec(pairUrl);
  return match?.[1];
}

export interface PairResult {
  jar: CookieJar;
  csrfToken: string | undefined;
  status: number;
  body: string;
  setCookies: string[];
}

export interface PairAuth {
  /** Owner session cookie to reuse (server keeps the owner session). */
  owner?: OwnerSession;
  /** Owner password for the anonymous phone-browser flow. */
  password?: string;
}

/**
 * Pair a browser with a device. With `owner`, the server keeps the existing
 * owner session; with `password`, an anonymous browser gets a device-bound
 * session, which is the real phone flow. With neither, the server must reject.
 */
export async function pairBrowser(edgeUrl: string, pairCode: string, auth: PairAuth = {}): Promise<PairResult> {
  const jar = auth.owner?.jar.clone() ?? new CookieJar();
  const page = await rawRequest(edgeUrl, {
    path: `/pair?code=${encodeURIComponent(pairCode)}`,
    headers: { accept: 'text/html', ...(jar.header() === undefined ? {} : { cookie: jar.header() as string }) },
  });
  jar.absorb(page.setCookies);
  const csrfToken = extractCsrf(page.bodyText) ?? csrfFromJar(jar) ?? auth.owner?.csrfToken;
  const form = new URLSearchParams({ code: pairCode });
  if (csrfToken !== undefined) form.set('csrf', csrfToken);
  if (auth.password !== undefined) form.set('password', auth.password);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: edgeUrl,
    accept: 'text/html,application/json',
    cookie: jar.header() ?? '',
  };
  if (csrfToken !== undefined) headers['x-csrf-token'] = csrfToken;
  const response = await rawRequest(edgeUrl, { method: 'POST', path: '/pair', headers, body: form.toString() });
  jar.absorb(response.setCookies);
  return { jar, csrfToken, status: response.status, body: response.bodyText, setCookies: response.setCookies };
}

/** Approve a pending device from the owner dashboard/API. */
export async function approveDevice(edgeUrl: string, owner: OwnerSession, deviceId: string): Promise<RawResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: edgeUrl,
    accept: 'application/json',
    cookie: owner.cookieHeader ?? '',
  };
  if (owner.csrfToken !== undefined) headers['x-csrf-token'] = owner.csrfToken;
  return await rawRequest(edgeUrl, { method: 'POST', path: `/v1/devices/${deviceId}/approve`, headers, body: '{}' });
}

/** Revoke a device from the owner dashboard/API. */
export async function revokeDevice(edgeUrl: string, owner: OwnerSession, deviceId: string): Promise<RawResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: edgeUrl,
    accept: 'application/json',
    cookie: owner.cookieHeader ?? '',
  };
  if (owner.csrfToken !== undefined) headers['x-csrf-token'] = owner.csrfToken;
  return await rawRequest(edgeUrl, { method: 'POST', path: `/v1/devices/${deviceId}/revoke`, headers, body: '{}' });
}

/* ------------------------------------------------------------------ */
/* Device API                                                          */
/* ------------------------------------------------------------------ */

export interface DeviceRegistration {
  deviceId: string;
  deviceSecret: string;
  pairCode: string;
  pairUrl: string;
  status: string;
}

/** Register a device directly through the public device API. */
export async function registerDevice(edgeUrl: string, name = 'harness-device'): Promise<DeviceRegistration> {
  const response = await rawRequest(edgeUrl, {
    method: 'POST',
    path: '/v1/devices/register',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ name, platform: 'test', agentVersion: '0.0.0-test' }),
  });
  if (response.status !== 201) {
    throw new Error(`register failed: HTTP ${String(response.status)} ${response.bodyText.slice(0, 400)}`);
  }
  return JSON.parse(response.bodyText) as DeviceRegistration;
}

/* ------------------------------------------------------------------ */
/* Full stack                                                          */
/* ------------------------------------------------------------------ */

export interface StackOptions {
  /** Extra CLI args for the edge, e.g. a shorter presence grace. */
  edgeArgs?: string[];
}

export interface LinkStack {
  edgeUrl: string;
  mock: MockDsh;
  agent: AgentHandleLike;
  deviceId: string;
  pairCode: string | undefined;
  owner: OwnerSession;
  browser: CookieJar;
  /** Agent state directory (identity file lives here). */
  agentStateDir: string;
  /** Edge data directory (dshrc.sqlite lives here). */
  edgeDataDir: string;
  /** Device secret from agent device.json (Bearer token for /v1/devices/me/*). */
  deviceSecret(): Promise<string>;
  /** Stop the edge and boot a new one on the same port + data dir; agent reconnects. */
  restartEdge(): Promise<EdgeProcess>;
  /** Full cookie header for the paired browser. */
  browserCookie(): string;
  /** Stop and restart the agent with the same identity/state dir. */
  restartAgent(): Promise<AgentHandleLike>;
  stop(): Promise<void>;
}

/**
 * Boot mock DSH -> edge -> agent, set up the owner, approve the device and pair
 * a browser. Every step polls with a deadline; a failure names the step.
 */
/** Password configured during first-run setup so both pair paths can be tested. */
export const OWNER_PASSWORD = 'harness-password-123';

export async function startStack(options: StackOptions = {}): Promise<LinkStack> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-rc-it-'));
  const edgeData = join(tempRoot, 'edge');
  const agentState = join(tempRoot, 'agent');
  const setupCode = `setup-${randomBytes(4).toString('hex')}`;
  let mock: MockDsh | undefined;
  let edge: EdgeProcess | undefined;
  let agent: AgentHandleLike | undefined;
  try {
    mock = await startMockDsh();
    const mockDsh = mock;
    edge = await startEdge({ dataDir: edgeData, setupCode, extraArgs: options.edgeArgs });
    const edgeProcess = edge;
    const owner = await waitFor(
      async () => {
        const session = await ownerSetup(edgeProcess.url, setupCode, OWNER_PASSWORD);
        return session.cookieHeader === undefined ? undefined : session;
      },
      { timeoutMs: 10_000, intervalMs: 50, label: 'owner setup' },
    );

    const agentModule = await loadAgentModule();
    const agentOptions = {
      edgeUrl: edgeProcess.url,
      dshUrl: mockDsh.authUrl,
      name: 'integration-agent',
      stateDir: agentState,
      insecure: true,
      logger: silentLogger,
    };
    agent = await agentModule.startAgent(agentOptions);
    const deviceId = (await waitFor(
      () => agent?.status().deviceId,
      { timeoutMs: 10_000, intervalMs: 10, label: 'agent device registration' },
    )) as string;
    const pairCode = pairCodeFromUrl(agent.status().pairUrl);

    // Pair first: the pair code is the user-facing approval path and consumes
    // the code in one shot. If there is no pair code, fall back to the owner API
    // (and use the owner session as the browser authorization).
    let browserJar = new CookieJar();
    let paired = false;
    if (pairCode !== undefined) {
      const result = await pairBrowser(edgeProcess.url, pairCode, { owner });
      if (result.status >= 400) {
        throw new Error(`pairing failed: HTTP ${String(result.status)} ${result.body.slice(0, 400)} (pair code ${pairCode})`);
      }
      browserJar = result.jar;
      paired = true;
    }
    if (!paired) {
      const approval = await approveDevice(edgeProcess.url, owner, deviceId);
      if (approval.status >= 400 && approval.status !== 404) {
        throw new Error(`device approval failed: HTTP ${String(approval.status)} ${approval.bodyText.slice(0, 400)}`);
      }
      browserJar = owner.jar.clone();
    }
    await agent.waitForOnline(15_000);

    return {
      edgeUrl: edgeProcess.url,
      mock: mockDsh,
      get agent() {
        return agent as AgentHandleLike;
      },
      deviceId,
      pairCode,
      owner,
      browser: browserJar,
      agentStateDir: agentState,
      edgeDataDir: edgeData,
      async deviceSecret() {
        const identity = JSON.parse(await readFile(join(agentState, 'device.json'), 'utf8')) as { deviceSecret: string };
        return identity.deviceSecret;
      },
      async restartEdge() {
        const previous = edge;
        await previous?.stop().catch(() => undefined);
        edge = await startEdge({ dataDir: edgeData, setupCode, port: previous?.port, extraArgs: options.edgeArgs });
        return edge;
      },
      browserCookie: () => browserJar.header() ?? '',
      async restartAgent() {
        // Release the singleton state-dir lock before starting a new instance.
        await agent?.stop().catch(() => undefined);
        const module = await loadAgentModule();
        agent = await module.startAgent(agentOptions);
        await agent.waitForOnline(15_000);
        return agent;
      },
      async stop() {
        await agent?.stop().catch(() => undefined);
        agent = undefined;
        await edge?.stop().catch(() => undefined);
        edge = undefined;
        await mock?.close().catch(() => undefined);
        mock = undefined;
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await agent?.stop().catch(() => undefined);
    await edge?.stop().catch(() => undefined);
    await mock?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return silentLogger;
  },
};

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Product-surface helpers                                             */
/* ------------------------------------------------------------------ */

/** Public path for a device resource: `/d/<deviceId>/<rest>`. */
export function devicePath(stack: Pick<LinkStack, 'deviceId'>, rest = '/'): string {
  if (rest === '') return `/d/${stack.deviceId}`;
  const suffix = rest.startsWith('/') ? rest : `/${rest}`;
  return `/d/${stack.deviceId}${suffix}`;
}

export interface BrowserFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Override the browser cookie header (e.g. to send a hostile extra cookie). */
  cookie?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual' | 'error';
}

/** Fetch a device resource the way a paired browser would. */
export async function browserFetch(
  stack: Pick<LinkStack, 'edgeUrl' | 'deviceId' | 'browserCookie'>,
  rest = '/',
  options: BrowserFetchOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  const cookie = options.cookie ?? stack.browserCookie();
  if (cookie !== '' && !headers.has('cookie')) headers.set('cookie', cookie);
  return await fetch(`${stack.edgeUrl}${devicePath(stack, rest)}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
    redirect: options.redirect ?? 'manual',
    signal: options.signal,
  });
}

/** Set-Cookie headers from a fetch Response (Node 20+ exposes getSetCookie). */
export function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [];
}

/** Wait for the next WebSocket message, rejecting on close/error/timeout. */
export async function nextWsMessage(
  socket: import('ws').WebSocket,
  timeoutMs = 5000,
): Promise<{ data: Buffer; isBinary: boolean }> {
  if (socket.readyState === socket.CLOSED) throw new Error('WebSocket is already closed');
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${String(timeoutMs)}ms waiting for a WebSocket message`));
    }, timeoutMs);
    const onMessage = (data: import('ws').RawData, isBinary: boolean): void => {
      cleanup();
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      resolve({ data: buffer, isBinary });
    };
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      reject(new Error(`WebSocket closed before a message arrived: ${String(code)} ${reason.toString('utf8')}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    socket.once('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

/** Wait for the WebSocket open event. */
export async function wsOpen(socket: import('ws').WebSocket, timeoutMs = 5000): Promise<void> {
  if (socket.readyState === socket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${String(timeoutMs)}ms waiting for WebSocket open`));
    }, timeoutMs);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

/** Close a WebSocket and wait for the close handshake (bounded). */
export async function closeWebSocket(socket: import('ws').WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      socket.close();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/** Wait until a TCP port accepts connections (used when killing tunnels). */
export async function waitForPort(host: string, port: number, timeoutMs = 5000): Promise<void> {
  await waitFor(async () => await new Promise<boolean>((resolve) => {
    const socket = netConnect({ host, port });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  }), { timeoutMs, intervalMs: 25, label: `port ${String(port)}` });
}
/* ------------------------------------------------------------------ */
/* Device-scoped sharing API (Bearer device secret)                    */
/* ------------------------------------------------------------------ */

export interface SharingInvite {
  id: string;
  label: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

export interface SharingGuest {
  sessionId: string;
  label?: string;
  ip?: string;
  since?: number;
  expiresAt: number | null;
}

export interface SharingPendingApproval {
  id: string;
  label?: string;
  ip?: string;
  createdAt?: number;
}

export interface SharingState {
  enabled: boolean;
  publicUrl?: string;
  invites: SharingInvite[];
  pendingApprovals: SharingPendingApproval[];
  activeGuests: SharingGuest[];
}

export interface CreatedInvite {
  id: string;
  url: string;
  token: string;
  expiresAt: number;
  label?: string;
  maxUses?: number;
}

export interface DeviceApiResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
  json: unknown;
}

/** Call a `/v1/devices/me/*` route with the device secret. */
export async function deviceApi(
  edgeUrl: string,
  deviceSecret: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<DeviceApiResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${deviceSecret}`,
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await rawRequest(edgeUrl, {
    method,
    path,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown;
  if (response.bodyText !== '') {
    try {
      json = JSON.parse(response.bodyText);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, headers: response.headers, bodyText: response.bodyText, json };
}

export async function getSharing(edgeUrl: string, deviceSecret: string): Promise<SharingState> {
  const response = await deviceApi(edgeUrl, deviceSecret, 'GET', '/v1/devices/me/sharing');
  if (response.status !== 200) {
    throw new Error(`GET sharing failed: HTTP ${String(response.status)} ${response.bodyText.slice(0, 400)}`);
  }
  return response.json as SharingState;
}

export async function setSharing(edgeUrl: string, deviceSecret: string, enabled: boolean): Promise<DeviceApiResult> {
  return await deviceApi(edgeUrl, deviceSecret, 'PUT', '/v1/devices/me/sharing', { enabled });
}

export interface InviteOptions {
  label?: string;
  /** 0 = never expires (docs/SHARING.md §5). */
  ttlSeconds?: number;
  maxUses?: number;
}

export async function createInvite(
  edgeUrl: string,
  deviceSecret: string,
  options: InviteOptions = {},
): Promise<CreatedInvite> {
  const response = await deviceApi(edgeUrl, deviceSecret, 'POST', '/v1/devices/me/invites', {
    label: options.label ?? 'guest',
    ttlSeconds: options.ttlSeconds ?? 3600,
    maxUses: options.maxUses ?? 1,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`create invite failed: HTTP ${String(response.status)} ${response.bodyText.slice(0, 400)}`);
  }
  return response.json as CreatedInvite;
}

export async function deleteInvite(edgeUrl: string, deviceSecret: string, inviteId: string): Promise<DeviceApiResult> {
  return await deviceApi(edgeUrl, deviceSecret, 'DELETE', `/v1/devices/me/invites/${encodeURIComponent(inviteId)}`);
}

export async function decideApproval(
  edgeUrl: string,
  deviceSecret: string,
  approvalId: string,
  decision: 'approve' | 'deny',
  ttlSeconds?: number,
): Promise<DeviceApiResult> {
  return await deviceApi(
    edgeUrl,
    deviceSecret,
    'POST',
    `/v1/devices/me/approvals/${encodeURIComponent(approvalId)}`,
    ttlSeconds === undefined ? { decision } : { decision, ttlSeconds },
  );
}

export async function revokeGuest(edgeUrl: string, deviceSecret: string, sessionId: string): Promise<DeviceApiResult> {
  return await deviceApi(edgeUrl, deviceSecret, 'DELETE', `/v1/devices/me/guests/${encodeURIComponent(sessionId)}`);
}

export async function revokeAllGuests(edgeUrl: string, deviceSecret: string): Promise<DeviceApiResult> {
  return await deviceApi(edgeUrl, deviceSecret, 'DELETE', '/v1/devices/me/guests');
}

/* ------------------------------------------------------------------ */
/* Guest invite flow (/i/*)                                            */
/* ------------------------------------------------------------------ */

export const GUEST_COOKIE = 'dshrc_guest';
export const CLAIM_COOKIE = 'dshrc_claim';

export interface InviteClaim {
  jar: CookieJar;
  status: number;
  bodyText: string;
  json: unknown;
  setCookies: string[];
}

/** GET the public invite page (also seeds any CSRF cookie the edge sets). */
export async function getInvitePage(edgeUrl: string, token: string): Promise<RawResponse> {
  return await rawRequest(edgeUrl, {
    path: `/i/${encodeURIComponent(token)}`,
    headers: { accept: 'text/html' },
  });
}

/**
 * POST /i/:token/claim (form-urlencoded `csrf`, same-origin). Accept: json asks
 * the edge for `{status,approvalId,deviceId}` instead of the 303 page.
 */
export async function claimInvite(edgeUrl: string, token: string): Promise<InviteClaim> {
  const jar = new CookieJar();
  const page = await getInvitePage(edgeUrl, token);
  jar.absorb(page.setCookies);
  const csrfToken = extractCsrf(page.bodyText) ?? csrfFromJar(jar) ?? '';
  const form = new URLSearchParams({ csrf: csrfToken });
  const headers: Record<string, string> = {
    origin: edgeUrl,
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    cookie: jar.header() ?? '',
    'x-csrf-token': csrfToken,
  };
  const response = await rawRequest(edgeUrl, {
    method: 'POST',
    path: `/i/${encodeURIComponent(token)}/claim`,
    headers,
    body: form.toString(),
  });
  jar.absorb(response.setCookies);
  let json: unknown;
  if (response.bodyText !== '') {
    try {
      json = JSON.parse(response.bodyText);
    } catch {
      json = undefined;
    }
  }
  return { jar, status: response.status, bodyText: response.bodyText, json, setCookies: response.setCookies };
}

export interface GuestStatus {
  jar: CookieJar;
  status: number;
  state: string | undefined;
  json: unknown;
  bodyText: string;
  setCookies: string[];
}

/** GET /i/:token/status with the claim cookie; absorbs the guest cookie on approval. */
export async function guestInviteStatus(edgeUrl: string, token: string, jar: CookieJar): Promise<GuestStatus> {
  const response = await rawRequest(edgeUrl, {
    path: `/i/${encodeURIComponent(token)}/status`,
    headers: { accept: 'application/json, text/html', cookie: jar.header() ?? '' },
  });
  jar.absorb(response.setCookies);
  let json: unknown;
  if (response.bodyText !== '') {
    try {
      json = JSON.parse(response.bodyText);
    } catch {
      json = undefined;
    }
  }
  let state: string | undefined;
  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;
    for (const key of ['status', 'state']) {
      if (typeof record[key] === 'string') {
        state = record[key] as string;
        break;
      }
    }
  }
  if (state === undefined) {
    const match = /\b(pending|approved|denied|expired)\b/i.exec(response.bodyText);
    state = match?.[1]?.toLowerCase();
  }
  return { jar, status: response.status, state, json, bodyText: response.bodyText, setCookies: response.setCookies };
}

/** Poll the invite status until the guest session cookie exists (approval landed). */
export async function waitForGuestSession(
  edgeUrl: string,
  token: string,
  jar: CookieJar,
  timeoutMs = 10_000,
): Promise<GuestStatus> {
  return await waitFor(async () => {
    const status = await guestInviteStatus(edgeUrl, token, jar);
    if (status.state === 'denied' || status.state === 'expired') {
      throw new Error(`invite ${token} was ${status.state}: ${status.bodyText.slice(0, 300)}`);
    }
    if (jar.get(GUEST_COOKIE) !== undefined || status.state === 'approved') return status;
    return undefined;
  }, { timeoutMs, intervalMs: 50, label: 'guest invite approval' });
}

/** GET /i/session to learn the guest device path and any CSRF token for Disconnect. */
export async function getGuestSessionPage(
  edgeUrl: string,
  jar: CookieJar,
): Promise<{ response: RawResponse; csrfToken: string | undefined }> {
  const response = await rawRequest(edgeUrl, {
    path: '/i/session',
    headers: { accept: 'text/html', cookie: jar.header() ?? '' },
  });
  jar.absorb(response.setCookies);
  return { response, csrfToken: extractCsrf(response.bodyText) ?? csrfFromJar(jar) };
}

/** POST /i/session/disconnect (guest-initiated, form-urlencoded csrf). */
export async function disconnectGuest(edgeUrl: string, jar: CookieJar): Promise<RawResponse> {
  const page = await getGuestSessionPage(edgeUrl, jar).catch(() => undefined);
  const csrfToken = page?.csrfToken ?? csrfFromJar(jar) ?? '';
  const form = new URLSearchParams({ csrf: csrfToken });
  const response = await rawRequest(edgeUrl, {
    method: 'POST',
    path: '/i/session/disconnect',
    headers: {
      origin: edgeUrl,
      accept: 'text/html, application/json',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: jar.header() ?? '',
      'x-csrf-token': csrfToken,
    },
    body: form.toString(),
  });
  jar.absorb(response.setCookies);
  return response;
}

/** Fetch a device resource with a guest cookie jar. */
export async function guestFetch(
  edgeUrl: string,
  deviceId: string,
  jar: CookieJar,
  rest = '/',
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; signal?: AbortSignal } = {},
): Promise<Response> {
  const suffix = rest === '' ? '' : rest.startsWith('/') ? rest : `/${rest}`;
  const headers = new Headers(options.headers);
  if (!headers.has('cookie')) headers.set('cookie', jar.header() ?? '');
  return await fetch(`${edgeUrl}/d/${deviceId}${suffix}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
    redirect: 'manual',
    signal: options.signal,
  });
}

/* ------------------------------------------------------------------ */
/* Granting a guest session in tests                                   */
/* ------------------------------------------------------------------ */

export interface GuestSession {
  label: string;
  token: string;
  inviteId: string;
  approvalId?: string;
  sessionId?: string;
  jar: CookieJar;
  status: GuestStatus;
}

export interface GrantGuestOptions {
  label?: string;
  ttlSeconds?: number;
  maxUses?: number;
  /** Extra fields for tests that want to observe the pending approval themselves. */
  prepareOnly?: boolean;
}

/**
 * Create an invite, claim it, approve it with the device secret and return the
 * guest cookie jar. `prepareOnly` stops after the claim so a test can assert the
 * pending approval before deciding.
 */
export async function createGuestSession(stack: LinkStack, options: GrantGuestOptions = {}): Promise<GuestSession> {
  const secret = await stack.deviceSecret();
  const sharing = await getSharing(stack.edgeUrl, secret);
  if (!sharing.enabled) {
    const enabled = await setSharing(stack.edgeUrl, secret, true);
    if (enabled.status !== 200) throw new Error(`enable sharing failed: HTTP ${String(enabled.status)} ${enabled.bodyText}`);
  }
  const invite = await createInvite(stack.edgeUrl, secret, {
    label: options.label ?? 'integration-guest',
    ttlSeconds: options.ttlSeconds ?? 3600,
    maxUses: options.maxUses ?? 1,
  });
  const claim = await claimInvite(stack.edgeUrl, invite.token);
  if (claim.status >= 400) {
    throw new Error(`claim failed: HTTP ${String(claim.status)} ${claim.bodyText.slice(0, 400)}`);
  }
  const state = await waitFor(async () => {
    const current = await getSharing(stack.edgeUrl, secret);
    const approval = current.pendingApprovals.at(-1);
    return approval === undefined ? undefined : { current, approval };
  }, { timeoutMs: 5000, intervalMs: 25, label: 'pending approval appears in sharing state' });

  if (options.prepareOnly === true) {
    return { label: invite.label ?? options.label ?? 'guest', token: invite.token, inviteId: invite.id, approvalId: state.approval.id, jar: claim.jar, status: { jar: claim.jar, status: 200, state: 'pending', json: undefined, bodyText: '', setCookies: [] } };
  }

  const decided = await decideApproval(stack.edgeUrl, secret, state.approval.id, 'approve');
  if (decided.status >= 400) {
    throw new Error(`approve failed: HTTP ${String(decided.status)} ${decided.bodyText.slice(0, 400)}`);
  }
  const status = await waitForGuestSession(stack.edgeUrl, invite.token, claim.jar);
  if (claim.jar.get(GUEST_COOKIE) === undefined) {
    throw new Error(`guest session cookie missing after approval; status=${String(status.status)} body=${status.bodyText.slice(0, 300)}`);
  }
  const decidedSessionId = typeof (decided.json as { sessionId?: unknown } | undefined)?.sessionId === 'string'
    ? (decided.json as { sessionId: string }).sessionId
    : undefined;
  const active = await getSharing(stack.edgeUrl, secret);
  const latest = active.activeGuests.find((entry) => entry.label === (invite.label ?? options.label ?? 'guest')) ?? active.activeGuests.at(-1);
  return {
    label: invite.label ?? options.label ?? 'guest',
    token: invite.token,
    inviteId: invite.id,
    approvalId: state.approval.id,
    ...(decidedSessionId === undefined && latest === undefined ? {} : { sessionId: decidedSessionId ?? latest?.sessionId }),
    jar: claim.jar,
    status,
  };
}

/* ------------------------------------------------------------------ */
/* Edge database inspection (read-only) and WS close helpers           */
/* ------------------------------------------------------------------ */

export function sha256HexLocal(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface InviteDbRow {
  id: string;
  device_id: string;
  token_hash: string;
  label: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
  revoked_at: number | null;
}

/** Read invite rows straight from the edge SQLite file (hash-at-rest proof). */
export function readInviteRows(edgeDataDir: string): InviteDbRow[] {
  const database = new sqliteModule.DatabaseSync(join(edgeDataDir, 'dshrc.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare('SELECT id, device_id, token_hash, label, created_at, expires_at, max_uses, uses, revoked_at FROM invites ORDER BY created_at').all();
    return rows.map((row) => ({
      id: String(row['id']),
      device_id: String(row['device_id']),
      token_hash: String(row['token_hash']),
      label: String(row['label']),
      created_at: Number(row['created_at']),
      expires_at: Number(row['expires_at']),
      max_uses: Number(row['max_uses']),
      uses: Number(row['uses']),
      revoked_at: row['revoked_at'] === null ? null : Number(row['revoked_at']),
    }));
  } finally {
    database.close();
  }
}

/** Resolve when a WebSocket closes; rejects on timeout. */
export async function waitForWsClose(
  socket: import('ws').WebSocket,
  timeoutMs = 5000,
): Promise<{ code: number; reason: string }> {
  if (socket.readyState === socket.CLOSED) return { code: -1, reason: '' };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${String(timeoutMs)}ms waiting for WebSocket close`));
    }, timeoutMs);
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      resolve({ code, reason: reason.toString('utf8') });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('close', onClose);
    };
    socket.once('close', onClose);
  });
}

export interface SessionDbRow {
  id: string;
  kind: string;
  device_id: string | null;
  expires_at: number | null;
  approval_id: string | null;
}

/** Read session rows straight from the edge SQLite file. */
export function readSessionRows(edgeDataDir: string): SessionDbRow[] {
  const database = new sqliteModule.DatabaseSync(join(edgeDataDir, 'dshrc.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare('SELECT id, kind, device_id, expires_at, approval_id FROM sessions ORDER BY created_at').all();
    return rows.map((row) => ({
      id: String(row['id']),
      kind: String(row['kind']),
      device_id: row['device_id'] === null ? null : String(row['device_id']),
      expires_at: row['expires_at'] === null ? null : Number(row['expires_at']),
      approval_id: row['approval_id'] === null ? null : String(row['approval_id']),
    }));
  } finally {
    database.close();
  }
}
