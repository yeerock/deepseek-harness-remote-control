/**
 * Test harness: boot an edge on an ephemeral port with a temp data dir, drive
 * it over HTTP the way a browser/agent would, and attach a fake agent tunnel.
 *
 * Nothing here shortcuts production code paths: pairing uses /pair, sessions
 * are real cookies, and the fake agent speaks the real protocol frames.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  FrameType,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  isHelloAck,
  type HelloAck,
} from '@dsh-rc/protocol';
import type { Stream } from '@dsh-rc/mux';
import { attachMux, type AttachedSocket } from '@dsh-rc/shared';
import { loadConfig, type EdgeConfig } from '../src/config.js';
import { createEdgeServer, type EdgeServer } from '../src/server.js';

export const TEST_SETUP_CODE = 'test-setup-code';
export const TEST_PASSWORD = 'test-password-1';

export interface TestEdge {
  edge: EdgeServer;
  base: string;
  dir: string;
  setupCode: string;
  close: () => Promise<void>;
}

export async function startEdge(overrides: Partial<EdgeConfig> = {}): Promise<TestEdge> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dshrc-edge-test-'));
  const config = loadConfig({
    argv: [
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      dir,
      '--insecure',
      '--setup-code',
      TEST_SETUP_CODE,
      '--log-level',
      'silent',
    ],
    overrides,
  });
  const edge = createEdgeServer({ config });
  const address = await edge.listen();
  return {
    edge,
    base: address.url,
    dir,
    setupCode: TEST_SETUP_CODE,
    close: async () => {
      await edge.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/* --------------------------------- cookies -------------------------------- */

export class Jar {
  private readonly cookies = new Map<string, string>();

  ingest(response: Response): void {
    const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of values) {
      const pair = raw.split(';')[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/* ---------------------------------- HTTP ---------------------------------- */

export interface HttpOptions {
  method?: string;
  jar?: Jar;
  form?: Record<string, string>;
  json?: unknown;
  /** Raw body, used for content-type-specific payloads. */
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  redirect?: 'follow' | 'manual' | 'error';
}

export async function http(base: string, pathname: string, options: HttpOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.jar !== undefined) {
    const cookie = options.jar.header();
    if (cookie !== '') headers['cookie'] = cookie;
  }
  let body: string | Uint8Array | undefined = options.body;
  if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  } else if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: options.redirect ?? 'manual',
  });
  options.jar?.ingest(response);
  return response;
}

export function extractCsrf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (match === null || match[1] === undefined) throw new Error('csrf field not found in page');
  return match[1];
}

/* ------------------------------- setup/login ------------------------------ */

export interface OwnerSession {
  jar: Jar;
  csrf: string;
  response: Response;
}

export async function setupOwner(base: string, options: { password?: string; code?: string } = {}): Promise<OwnerSession> {
  const jar = new Jar();
  const page = await http(base, '/setup', { jar });
  const csrf = extractCsrf(await page.text());
  const form: Record<string, string> = { csrf, code: options.code ?? TEST_SETUP_CODE };
  const password = options.password ?? TEST_PASSWORD;
  if (password !== '') form['password'] = password;
  const response = await http(base, '/setup', { method: 'POST', jar, form, headers: { origin: base } });
  return { jar, csrf, response };
}

export async function loginOwner(base: string, password = TEST_PASSWORD): Promise<OwnerSession> {
  const jar = new Jar();
  const page = await http(base, '/login', { jar });
  const csrf = extractCsrf(await page.text());
  const response = await http(base, '/login', { method: 'POST', jar, form: { csrf, password }, headers: { origin: base } });
  return { jar, csrf, response };
}

/* -------------------------------- devices --------------------------------- */

export interface RegisteredDevice {
  deviceId: string;
  deviceSecret: string;
  pairCode: string;
  pairUrl: string;
  status: string;
}

export async function registerDevice(base: string, name = 'test-device'): Promise<RegisteredDevice> {
  const response = await http(base, '/v1/devices/register', {
    method: 'POST',
    json: { name, platform: 'test', agentVersion: '0.1.0' },
  });
  if (response.status !== 201) throw new Error(`register failed: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as RegisteredDevice;
}

export interface PairOptions {
  /** Existing owner session jar. */
  ownerJar?: Jar;
  /** Owner password, required when no owner session is present. */
  password?: string;
  /** Jar to keep cookies in; defaults to a fresh browser jar. */
  jar?: Jar;
}

export async function pairDevice(base: string, code: string, options: PairOptions = {}): Promise<{ jar: Jar; response: Response }> {
  const jar = options.ownerJar ?? options.jar ?? new Jar();
  const page = await http(base, `/pair?code=${encodeURIComponent(code)}`, { jar });
  const csrf = extractCsrf(await page.text());
  const form: Record<string, string> = { csrf, code };
  if (options.ownerJar === undefined) form['password'] = options.password ?? TEST_PASSWORD;
  const response = await http(base, '/pair', { method: 'POST', jar, form, headers: { origin: base } });
  return { jar, response };
}

/** Register and pair a device as the owner; returns the owner jar for access. */
export async function provisionDevice(base: string, ownerJar: Jar): Promise<{
  device: RegisteredDevice;
  jar: Jar;
}> {
  const device = await registerDevice(base);
  const paired = await pairDevice(base, device.pairCode, { ownerJar });
  return { device, jar: paired.jar };
}

export function addCookie(jar: Jar, name: string, value: string): void {
  jar.set(name, value);
}

/* ------------------------------- fake agent ------------------------------- */

export interface HelloOverrides {
  protocol?: number;
  deviceId?: string;
  token?: string;
  agentVersion?: string;
  platform?: string;
}

export interface OpenSocketResult {
  ws: WebSocket;
}

/** Open the WebSocket and stop before HELLO. Rejects with the HTTP status on a non-101. */
export async function openTunnelSocket(base: string, secret: string): Promise<WebSocket> {
  const url = `${base.replace(/^http/, 'ws')}/v1/tunnel`;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } });
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onUnexpected = (_request: unknown, response: { statusCode?: number }): void => {
      cleanup();
      reject(Object.assign(new Error(`tunnel upgrade rejected: ${String(response.statusCode)}`), { statusCode: response.statusCode }));
    };
    const cleanup = (): void => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('unexpected-response', onUnexpected);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('unexpected-response', onUnexpected);
  });
  return ws;
}

export function sendHello(ws: WebSocket, deviceId: string, secret: string, overrides: HelloOverrides = {}): void {
  const hello = {
    protocol: overrides.protocol ?? 1,
    deviceId: overrides.deviceId ?? deviceId,
    token: overrides.token ?? secret,
    agentVersion: overrides.agentVersion ?? '0.1.0',
    platform: overrides.platform ?? 'test',
    maxFrameBytes: 65536,
  };
  ws.send(encodeFrame(FrameType.Hello, 0, encodeJson(hello)), { binary: true });
}

export async function readHelloAck(ws: WebSocket): Promise<HelloAck> {
  const raw = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for HELLO_ACK'));
    }, 5_000);
    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (!isBinary) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(data);
    };
    ws.on('message', onMessage);
  });
  const bytes = new Uint8Array(raw as Buffer);
  const frame = decodeFrame(bytes);
  if (frame.type !== FrameType.HelloAck) throw new Error(`expected HELLO_ACK, got frame ${String(frame.type)}`);
  return decodeJson(frame.payload, isHelloAck);
}

export function waitForClose(ws: WebSocket, timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

export interface FakeAgent {
  ws: WebSocket;
  attached: AttachedSocket;
  ack: HelloAck;
  streams: Stream[];
  close: () => Promise<void>;
}

export interface FakeAgentHandler {
  onStream?: (stream: Stream, agent: FakeAgent) => void;
  hello?: HelloOverrides;
  heartbeatMs?: number;
  idleTimeoutMs?: number;
}

/** Complete the tunnel handshake and attach a real mux as the agent side. */
export async function connectTunnel(
  base: string,
  deviceId: string,
  secret: string,
  handler: FakeAgentHandler = {},
): Promise<FakeAgent> {
  const ws = await openTunnelSocket(base, secret);
  sendHello(ws, deviceId, secret, handler.hello);
  const ack = await readHelloAck(ws);
  if (!ack.ok) {
    ws.close();
    throw new Error(`HELLO_ACK failed: ${ack.code} ${ack.message}`);
  }
  const streams: Stream[] = [];
  const agent = {
    ws,
    streams,
    ack,
    attached: attachMux(ws, {
      role: 'agent',
      heartbeatMs: handler.heartbeatMs ?? 60_000,
      idleTimeoutMs: handler.idleTimeoutMs ?? 120_000,
      onStream: (stream) => {
        streams.push(stream);
        handler.onStream?.(stream, agent);
      },
    }),
    close: async () => {
      try {
        agent.attached.mux.close(1000, 'test done');
      } catch {
        /* already closed */
      }
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    },
  } satisfies FakeAgent;
  return agent;
}

/** Read the next DATA/END body off a stream as a UTF-8 string. */
export async function readStreamBody(stream: Stream): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream.body()) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}