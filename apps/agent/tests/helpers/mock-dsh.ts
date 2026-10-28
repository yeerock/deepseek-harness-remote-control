/**
 * Minimal DSH stand-in for agent tests.
 *
 * Mirrors the parts of the real desktop web server the agent depends on:
 * one-time `?token=` exchange returning a 303 + Set-Cookie (without following
 * the redirect), a cookie-fenced origin, an echo endpoint, a streaming
 * endpoint, a never-answering endpoint for abort tests, and an echo WebSocket.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Duplex } from 'node:stream';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  at: number;
}

interface SlowRequest {
  request: IncomingMessage;
  response: ServerResponse;
  closed: Promise<void>;
  resolveClosed: () => void;
}

export interface MockDshOptions {
  /** Expected launch token. Defaults to `test-token`. */
  token?: string;
  /** Require the session cookie on every non-exchange route. Defaults to true. */
  requireAuth?: boolean;
  /** WS subprotocols the mock accepts. */
  wsProtocols?: string[];
}

export class MockDsh {
  readonly requests: RecordedRequest[] = [];
  readonly cookieName = 'dsh_session';
  readonly acceptedWsProtocols: Set<string>;
  readonly validCookies = new Set<string>();
  readonly wsRequests: Array<{ url: string; headers: IncomingMessage['headers']; protocol: string }> = [];
  readonly slowRequests: SlowRequest[] = [];

  token: string;
  requireAuth: boolean;
  exchangeCount = 0;
  exchangeStartedCount = 0;
  exchangeDelayMs = 0;
  wsMessageCount = 0;

  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private cookieCounter = 0;
  private origin = '';

  constructor(options: MockDshOptions = {}) {
    this.token = options.token ?? 'test-token';
    this.requireAuth = options.requireAuth ?? true;
    this.acceptedWsProtocols = new Set(options.wsProtocols ?? ['dsh-remote']);
  }

  get port(): number {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') throw new Error('mock dsh not listening');
    return (address as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** Authenticated launch URL, as the DSH plugin would hand to the agent. */
  get authenticatedUrl(): string {
    return `${this.url}/?token=${encodeURIComponent(this.token)}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        for (const protocol of protocols) {
          if (this.acceptedWsProtocols.has(protocol)) return protocol;
        }
        return false;
      },
    });
    this.wss.on('connection', (socket: WebSocket, request) => {
      this.wsRequests.push({
        url: request.url ?? '',
        headers: request.headers,
        protocol: socket.protocol,
      });
      socket.on('message', (data, isBinary) => {
        this.wsMessageCount += 1;
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
        socket.send(`echo:${text}`, { binary: isBinary });
      });
    });
    this.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path !== '/ws') {
        socket.destroy();
        return;
      }
      if (this.requireAuth && !this.cookieIsValid(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  /** Invalidate every issued session cookie; the next exchange issues a fresh one. */
  invalidateCookies(): void {
    this.validCookies.clear();
  }

  issueCookie(): string {
    this.cookieCounter += 1;
    const value = `s${String(this.cookieCounter)}`;
    this.validCookies.add(value);
    return value;
  }

  private cookieIsValid(request: IncomingMessage): boolean {
    const header = request.headers.cookie;
    if (header === undefined) return false;
    for (const part of header.split(';')) {
      const [rawName, ...rest] = part.trim().split('=');
      if (rawName !== this.cookieName) continue;
      return this.validCookies.has(rest.join('='));
    }
    return false;
  }

  private record(request: IncomingMessage): void {
    this.requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      headers: request.headers,
      at: Date.now(),
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.record(request);
    const url = new URL(request.url ?? '/', this.url);

    if (url.pathname === '/') {
      if (url.searchParams.has('token')) {
        this.exchangeCount += 1;
        this.exchangeStartedCount += 1;
        const mismatch = url.searchParams.get('token') !== this.token;
        const respond = (): void => {
          if (mismatch) {
            response.writeHead(401, { 'content-type': 'text/plain' });
            response.end('bad launch token');
            return;
          }
          const cookie = this.issueCookie();
          response.writeHead(303, {
            location: '/',
            'set-cookie': `${this.cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Lax`,
          });
          response.end();
        };
        if (this.exchangeDelayMs > 0) setTimeout(respond, this.exchangeDelayMs);
        else respond();
        return;
      }
      if (this.requireAuth && !this.cookieIsValid(request)) {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('cookie required');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>mock dsh</title><h1>dsh-home</h1>');
      return;
    }

    if (this.requireAuth && !this.cookieIsValid(request)) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('cookie required');
      return;
    }

    switch (url.pathname) {
      case '/echo-headers': {
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=evil; Path=/' });
        response.end(JSON.stringify({ headers: request.headers }));
        return;
      }
      case '/set-cookie': {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': 'upstream=evil; Path=/',
          'x-upstream': 'yes',
        });
        response.end('ok');
        return;
      }
      case '/echo': {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ method: request.method, body, length: Buffer.byteLength(body) }));
        });
        return;
      }
      case '/stream': {
        const total = Number(url.searchParams.get('bytes') ?? '1024');
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        let sent = 0;
        const chunk = Buffer.alloc(Math.min(16 * 1024, total), 0x61);
        const writeMore = (): void => {
          while (sent < total) {
            const slice = chunk.subarray(0, Math.min(chunk.byteLength, total - sent));
            sent += slice.byteLength;
            if (!response.write(slice)) {
              response.once('drain', writeMore);
              return;
            }
          }
          response.end();
        };
        writeMore();
        return;
      }
      case '/slow': {
        let resolveClosed: () => void = () => undefined;
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        this.slowRequests.push({ request, response, closed, resolveClosed });
        request.on('close', () => resolveClosed());
        response.on('close', () => resolveClosed());
        // Deliberately never respond.
        return;
      }
      default: {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      }
    }
  }

  async waitForSlowRequest(timeoutMs = 5_000): Promise<SlowRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const last = this.slowRequests[this.slowRequests.length - 1];
      if (last !== undefined) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('mock DSH did not receive a /slow request');
  }

  async waitForExchangeStart(count = 1, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exchangeStartedCount >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`mock DSH saw ${String(this.exchangeStartedCount)} exchanges; wanted ${String(count)}`);
  }

  async stop(): Promise<void> {
    for (const slow of this.slowRequests) {
      slow.response.destroy();
      slow.resolveClosed();
    }
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }
}