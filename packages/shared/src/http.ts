import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';

export const MAX_JSON_BODY_BYTES = 256 * 1024;

export function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Parse a Cookie header into a plain object; the first occurrence wins. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals <= 0) continue;
    const name = part.slice(0, equals).trim();
    if (name === '' || name in out) continue;
    const raw = part.slice(equals + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  domain?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`);
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/** Read a JSON request body with a hard byte ceiling. Returns undefined on invalid input. */
export async function readJsonBody<T = unknown>(request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export async function readFormBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return new URLSearchParams();
  const type = requestHeader(request, 'content-type') ?? '';
  if (!type.includes('application/x-www-form-urlencoded')) return undefined;
  return new URLSearchParams(text);
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

export function sendText(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void {
  const payload = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

export function sendHtml(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  sendText(response, status, body, 'text/html; charset=utf-8', headers);
}

export function redirect(response: ServerResponse, status: 302 | 303 | 307 | 308, location: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    location,
    'cache-control': 'no-store',
    'content-length': '0',
    ...headers,
  });
  response.end();
}

/** Applied to every edge-rendered page, never to proxied DSH responses. */
export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  // `no-referrer` makes Chromium send `Origin: null` on form POSTs, which the
  // edge's CSRF origin check must then reject. `same-origin` keeps cross-origin
  // referrers empty while preserving a real Origin for our own forms.
  response.setHeader('referrer-policy', 'same-origin');
  response.setHeader('permissions-policy', 'interest-cohort=(), camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

const TRUSTED_PROXY_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;

/**
 * Client address for logs and rate limits. Forwarded headers are honoured only
 * when the deployment declares a trusted proxy; otherwise any client could
 * forge its own rate-limit bucket.
 */
export function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    for (const name of TRUSTED_PROXY_HEADERS) {
      const value = requestHeader(request, name);
      if (value === undefined) continue;
      const first = value.split(',')[0]?.trim();
      if (first !== undefined && first !== '') return first;
    }
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/** Whether this request arrived over TLS at this process (not behind a proxy). */
export function isSecureSocket(socket: import('node:net').Socket): boolean {
  return socket instanceof TLSSocket && socket.encrypted;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === '::1' || address.startsWith('127.')) return true;
  if (address.startsWith('::ffff:127.')) return true;
  return false;
}

/** Absolute origin the browser used, from headers, for redirects and cookies. */
export function requestOrigin(request: IncomingMessage, publicUrl: string, trustProxy: boolean): string {
  if (publicUrl !== '') return publicUrl.replace(/\/$/, '');
  const proto = trustProxy
    ? (requestHeader(request, 'x-forwarded-proto') ?? 'http')
    : (isSecureSocket(request.socket) ? 'https' : 'http');
  const host = requestHeader(request, 'host') ?? '127.0.0.1';
  return `${proto}://${host}`;
}

/** Write with backpressure. Resolves once the kernel accepted the chunk. */
export function writeWithDrain(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.destroyed) return Promise.reject(new Error('response destroyed'));
  const ok = response.write(chunk);
  if (ok) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('response closed'));
    };
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

/** Copy a Node readable stream to a destination with backpressure. */
export async function pipeBody(
  source: AsyncIterable<Uint8Array>,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  for await (const chunk of source) {
    await write(chunk);
  }
}