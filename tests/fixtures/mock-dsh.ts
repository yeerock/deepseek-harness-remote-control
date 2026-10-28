/**
 * Mock DeepSeek Harness web surface.
 *
 * This is a real HTTP + WebSocket server, not a stub: the agent's DSH bootstrap
 * (token -> cookie exchange), its loopback proxy and its WebSocket relay all run
 * against it unmodified. It records what actually arrived so tests can assert on
 * headers, bodies and client aborts rather than on the proxy's own claims.
 *
 * Surface:
 *   GET  /?token=<token>        303 + Set-Cookie (the DSH launch-token exchange)
 *   GET  /                      200 HTML index, requires the cookie
 *   GET  /api/status            200 JSON, requires the cookie
 *   GET  /api/headers           200 JSON echo of the upstream request headers
 *   GET  /api/stream?bytes=N    chunked streaming response (default 1 MiB + 123 B)
 *   GET  /api/slow?ms=N         headers delayed by N ms
 *   GET  /api/abort-watch       endless trickle; records a client abort
 *   GET  /api/redirect         302 absolute loopback Location
 *   GET  /api/set-cookie       200 with Set-Cookie + HSTS (must be stripped)
 *   POST /api/echo             JSON echo of method/path/headers/body
 *   WS   /api/remote.mux       echo (text and binary), requires the cookie
 *
 * Every route requires a valid session cookie except the token exchange and
 * /api/set-cookie, and returns 401 otherwise.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

export const MOCK_DSH_COOKIE = 'dsh_session';
export const MOCK_DSH_WS_PATH = '/api/remote.mux';

/** Deterministic, position-dependent body bytes (period 256, block-repeatable). */
export function patternBytes(length: number): Buffer {
  const block = Buffer.allocUnsafe(65_536);
  for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + 7) & 0xff;
  if (length <= block.length) return block.subarray(0, length);
  const out = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    offset += block.copy(out, offset, 0, Math.min(block.length, length - offset));
  }
  return out;
}

export interface RecordedRequest {
  id: number;
  method: string;
  url: string;
  pathname: string;
  search: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
  aborted: boolean;
  completed: boolean;
  status?: number;
  receivedAt: number;
  durationMs?: number;
}

export interface RecordedWsConnection {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
  openedAt: number;
  closedAt?: number;
  messages: Array<{ binary: boolean; text: string }>;
  closeCode?: number;
}

export interface MockDshOptions {
  /** Launch token accepted by the exchange endpoint. Random when omitted. */
  token?: string;
  /** Session cookie value set by the exchange and required afterwards. */
  cookieValue?: string;
  /** Require the session cookie on the index/API/WS routes (default true). */
  requireCookie?: boolean;
  /** Optional HTML body for the index page. */
  indexHtml?: string;
}

/**
 * One mock DSH instance. `start()` binds 127.0.0.1:0; `close()` destroys every
 * socket it owns so tests leave no handles behind.
 */
export class MockDsh {
  readonly token: string;
  readonly cookieValue: string;
  readonly requireCookie: boolean;
  readonly indexHtml: string;
  readonly requests: RecordedRequest[] = [];
  readonly wsConnections: RecordedWsConnection[] = [];

  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private port = 0;
  private nextId = 1;
  private readonly sockets = new Set<import('node:net').Socket>();

  constructor(options: MockDshOptions = {}) {
    this.token = options.token ?? `tok_${randomBytes(12).toString('hex')}`;
    this.cookieValue = options.cookieValue ?? `sess_${randomBytes(12).toString('hex')}`;
    this.requireCookie = options.requireCookie ?? true;
    this.indexHtml = options.indexHtml ?? [
      '<!doctype html><html><head><base href="./"><title>Mock DSH</title>',
      '<link rel="stylesheet" href="assets/app.css"></head>',
      '<body><div id="root">mock dsh index</div>',
      '<script type="module" src="assets/app.js"></script></body></html>',
    ].join('');
  }

  /** Base URL once started, e.g. `http://127.0.0.1:53421`. */
  get url(): string {
    if (this.port === 0) throw new Error('mock dsh is not started');
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** Launch URL the agent is expected to bootstrap with. */
  get authUrl(): string {
    return `${this.url}/?token=${encodeURIComponent(this.token)}`;
  }

  get cookieHeader(): string {
    return `${MOCK_DSH_COOKIE}=${this.cookieValue}`;
  }

  async start(): Promise<this> {
    if (this.server !== undefined) return this;
    const server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
    server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.port = address.port;
    this.server = server;
    return this;
  }

  async close(): Promise<void> {
    for (const client of this.wss?.clients ?? []) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      if (this.wss === undefined) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    this.wss = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (this.server === undefined) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.server = undefined;
    this.port = 0;
  }

  /** Requests whose URL pathname matches exactly. */
  requestsTo(pathname: string): RecordedRequest[] {
    return this.requests.filter((entry) => entry.pathname === pathname);
  }

  /** Requests the client abandoned before the response completed. */
  get abortedRequests(): RecordedRequest[] {
    return this.requests.filter((entry) => entry.aborted);
  }

  /* ------------------------------ HTTP ------------------------------ */

  private record(request: IncomingMessage): RecordedRequest {
    const parsed = new URL(request.url ?? '/', 'http://mock.invalid');
    const entry: RecordedRequest = {
      id: this.nextId++,
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      pathname: parsed.pathname,
      search: parsed.search,
      headers: { ...request.headers },
      rawHeaders: [...request.rawHeaders],
      body: '',
      aborted: false,
      completed: false,
      receivedAt: Date.now(),
    };
    this.requests.push(entry);
    return entry;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const entry = this.record(request);
    const parsed = new URL(request.url ?? '/', this.url);
    const pathname = parsed.pathname;

    response.on('close', () => {
      entry.durationMs = Date.now() - entry.receivedAt;
      if (!entry.completed) {
        entry.aborted = true;
      }
    });

    try {
      if (pathname === '/' && parsed.searchParams.has('token')) {
        const supplied = parsed.searchParams.get('token') ?? '';
        if (supplied !== this.token) {
          entry.status = 403;
          this.finish(entry, response, 403, 'invalid launch token');
          return;
        }
        entry.status = 303;
        response.writeHead(303, {
          location: '/',
          'set-cookie': `${MOCK_DSH_COOKIE}=${this.cookieValue}; Path=/; HttpOnly; SameSite=Lax`,
          'cache-control': 'no-store',
          'content-length': '0',
        });
        response.end();
        entry.completed = true;
        return;
      }

      if (pathname === '/api/set-cookie') {
        // Deliberately includes headers the edge must strip back to the browser.
        entry.status = 200;
        this.finish(entry, response, 200, 'cookie-set', {
          'set-cookie': 'dsh_private=leak; Path=/; HttpOnly',
          'strict-transport-security': 'max-age=63072000',
        });
        return;
      }

      if (this.requireCookie && !this.hasCookie(request)) {
        entry.status = 401;
        this.finish(entry, response, 401, 'unauthorized');
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        entry.status = 200;
        this.finish(entry, response, 200, this.indexHtml, { 'content-type': 'text/html; charset=utf-8' });
        return;
      }

      if (pathname === '/api/status') {
        entry.status = 200;
        this.finish(entry, response, 200, JSON.stringify({ ok: true, upstream: 'mock-dsh', at: Date.now() }), {
          'content-type': 'application/json; charset=utf-8',
        });
        return;
      }

      if (pathname === '/api/headers') {
        entry.status = 200;
        this.finish(entry, response, 200, JSON.stringify({ headers: entry.headers, url: entry.url }), {
          'content-type': 'application/json; charset=utf-8',
        });
        return;
      }

      if (pathname === '/api/echo') {
        entry.body = await readBody(request);
        entry.status = 200;
        this.finish(entry, response, 200, JSON.stringify({
          method: entry.method,
          url: entry.url,
          headers: entry.headers,
          body: entry.body,
        }), { 'content-type': 'application/json; charset=utf-8' });
        return;
      }

      if (pathname === '/assets/app.js') {
        entry.status = 200;
        this.finish(entry, response, 200, 'console.log("mock-dsh");', { 'content-type': 'text/javascript; charset=utf-8' });
        return;
      }

      if (pathname === '/assets/app.css') {
        entry.status = 200;
        this.finish(entry, response, 200, 'body{margin:0}', { 'content-type': 'text/css; charset=utf-8' });
        return;
      }

      if (pathname === '/api/stream' || pathname === '/api/large' || pathname === '/assets/bulk.js') {
        const bytes = Number(parsed.searchParams.get('bytes') ?? String(1024 * 1024 + 123));
        const chunkBytes = Number(parsed.searchParams.get('chunk') ?? String(32 * 1024));
        const delayMs = Number(parsed.searchParams.get('delayMs') ?? '0');
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
          entry.status = 400;
          this.finish(entry, response, 400, 'bad byte count');
          return;
        }
        entry.status = 200;
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          ...(bytes === 0 ? { 'content-length': '0' } : {}),
        });
        await this.writePattern(entry, response, bytes, chunkBytes, delayMs);
        return;
      }

      if (pathname === '/api/slow') {
        const ms = Math.max(0, Math.min(30_000, Number(parsed.searchParams.get('ms') ?? '250')));
        await delay(ms);
        if (response.destroyed) return;
        entry.status = 200;
        this.finish(entry, response, 200, 'slow-ok');
        return;
      }

      if (pathname === '/api/abort-watch') {
        entry.status = 200;
        response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        const timer = setInterval(() => {
          if (response.destroyed) return;
          response.write('tick\n');
        }, 25);
        timer.unref?.();
        response.on('close', () => clearInterval(timer));
        // Never ends on its own: the client must abort, which the response
        // 'close' handler records as aborted.
        return;
      }

      if (pathname === '/api/redirect') {
        entry.status = 302;
        response.writeHead(302, {
          location: `${this.url}/api/status`,
          'content-length': '0',
          'cache-control': 'no-store',
        });
        response.end();
        entry.completed = true;
        return;
      }

      entry.status = 404;
      this.finish(entry, response, 404, 'not found');
    } catch (error) {
      entry.status = 500;
      if (!response.headersSent) {
        this.finish(entry, response, 500, error instanceof Error ? error.message : String(error));
      } else {
        response.destroy();
      }
    }
  }

  private finish(entry: RecordedRequest, response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    const payload = Buffer.from(body, 'utf8');
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(payload.byteLength),
      'cache-control': 'no-store',
      ...headers,
    });
    response.end(payload);
    entry.completed = true;
  }

  private async writePattern(
    entry: RecordedRequest,
    response: ServerResponse,
    bytes: number,
    chunkBytes: number,
    delayMs: number,
  ): Promise<void> {
    const block = patternBytes(Math.min(chunkBytes, 65_536));
    let sent = 0;
    while (sent < bytes && !response.destroyed) {
      const size = Math.min(block.length, bytes - sent);
      const ok = response.write(size === block.length ? block : block.subarray(0, size));
      sent += size;
      if (delayMs > 0) await delay(delayMs);
      else if (!ok) await onceDrain(response);
    }
    if (!response.destroyed) {
      response.end();
      entry.completed = true;
    }
  }

  /* --------------------------- WebSocket --------------------------- */

  private handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const parsed = new URL(request.url ?? '/', this.url);
    if (parsed.pathname !== MOCK_DSH_WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.requireCookie && !this.hasCookie(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const connection: RecordedWsConnection = {
      url: request.url ?? '/',
      headers: { ...request.headers },
      protocol: '',
      openedAt: Date.now(),
      messages: [],
    };
    this.wsConnections.push(connection);
    this.wss?.handleUpgrade(request, socket, head, (client: WebSocket) => {
      connection.protocol = client.protocol;
      client.on('message', (data, isBinary) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        connection.messages.push({ binary: isBinary, text: buffer.toString('utf8') });
        // Echo verbatim, preserving text/binary.
        client.send(buffer, { binary: isBinary });
      });
      client.on('close', (code) => {
        connection.closedAt = Date.now();
        connection.closeCode = code;
      });
    });
  }

  /* ---------------------------- helpers ---------------------------- */

  private hasCookie(request: IncomingMessage): boolean {
    const header = request.headers.cookie;
    if (header === undefined) return false;
    for (const part of header.split(';')) {
      const equals = part.indexOf('=');
      if (equals <= 0) continue;
      if (part.slice(0, equals).trim() !== MOCK_DSH_COOKIE) continue;
      return part.slice(equals + 1).trim() === this.cookieValue;
    }
    return false;
  }
}

async function readBody(request: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      request.destroy();
      return '<body-too-large>';
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
  });
}

/** Start a mock DSH on an ephemeral loopback port. */
export async function startMockDsh(options: MockDshOptions = {}): Promise<MockDsh> {
  const mock = new MockDsh(options);
  await mock.start();
  return mock;
}