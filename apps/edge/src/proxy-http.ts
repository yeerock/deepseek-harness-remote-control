/**
 * HTTP proxying for `/d/<deviceId>/*`.
 *
 * The edge is a byte pump with policy: it filters headers in both directions,
 * opens one mux stream per request, streams the body with real backpressure
 * (writeWithDrain -> mux credit), rewrites absolute loopback redirects and
 * never forwards browser credentials to the agent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import {
  DEVICE_MOUNT_PREFIX,
  assertSafeOriginPath,
  classifyPriority,
  filterRequestHeaders,
  filterResponseHeaders,
  rewriteLocation as rewriteProtocolLocation,
  type HeaderPair,
} from '@dsh-rc/protocol';
import { newId, requestHeader, sendJson, writeWithDrain, type Logger } from '@dsh-rc/shared';
import type { EdgeConfig } from './config.js';
import type { DeviceRow } from './db.js';
import { sendErrorPage } from './respond.js';
import type { TunnelManager } from './tunnels.js';

export interface DeviceHttpRequest {
  config: EdgeConfig;
  logger: Logger;
  tunnels: TunnelManager;
  device: DeviceRow;
  request: IncomingMessage;
  response: ServerResponse;
  /** Origin-form path with the public `/d/<id>` prefix removed, no query. */
  rest: string;
  /** Raw query string including the leading `?`, or ''. */
  search: string;
  publicOrigin: string;
  /** Guest responses get the fixed Disconnect pill injected into HTML. */
  guest?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\./.test(host);
}

/** Rewrite `http://127.0.0.1:<dshPort>/x` to `/d/<id>/x`; leave anything else alone. */
export function rewriteLoopbackLocation(location: string, publicBase: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return location;
  if (!isLoopbackHostname(url.hostname)) return location;
  return rewriteProtocolLocation(location, `${url.protocol}//${url.host}`, publicBase);
}

/** A mux `STREAM_LIMIT` (256 concurrent streams) is saturation, not a dead tunnel. */
export function isStreamLimitError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'STREAM_LIMIT';
}

function wantsJson(request: IncomingMessage, rest: string): boolean {
  return rest.startsWith('/api/') || (requestHeader(request, 'accept') ?? '').includes('application/json');
}

/** Fixed, edge-owned control injected into guest HTML only. */
export const GUEST_PILL_HTML = '<script>globalThis.__DSH_RC_GUEST__=true</script><div id="dshrc-guest-pill" style="position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#131a2e;color:#e6ecff;border:1px solid #26314d;border-radius:999px;padding:10px 16px;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 24px #0008"><a href="/i/session" style="color:inherit;text-decoration:none">Remote session &middot; Disconnect</a></div>';
const MAX_INJECT_BYTES = 2 * 1024 * 1024;
const MAX_INJECT_DECODED_BYTES = 8 * 1024 * 1024;

function decodeHtmlBody(body: Buffer, encoding: string | undefined): Buffer | null {
  if (encoding === undefined || encoding === '' || encoding === 'identity') return body;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(body);
    if (encoding === 'deflate') return inflateSync(body);
    if (encoding === 'br') return brotliDecompressSync(body);
    return null;
  } catch {
    return null;
  }
}

function headerValueOf(pairs: HeaderPair[], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of pairs) if (key.toLowerCase() === lower) return value;
  return undefined;
}

function injectGuestPill(original: Buffer): Buffer | null {
  const text = original.toString('utf8');
  const index = text.toLowerCase().lastIndexOf('</body');
  if (index < 0) return null;
  return Buffer.from(`${text.slice(0, index)}${GUEST_PILL_HTML}${text.slice(index)}`, 'utf8');
}

/** Buffer a small guest HTML document, inject the pill, then send it. */
async function streamGuestHtml(
  stream: { body(): AsyncIterable<Uint8Array> },
  response: ServerResponse,
  status: number,
  headers: Record<string, string | string[]>,
): Promise<'sent' | 'failed'> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let committed = false;
  try {
    for await (const chunk of stream.body()) {
      if (response.destroyed) return 'sent';
      if (!committed) {
        if (total + chunk.byteLength > MAX_INJECT_BYTES) {
          response.writeHead(status, headers);
          for (const buffered of chunks) await writeWithDrain(response, buffered);
          chunks.length = 0;
          committed = true;
          await writeWithDrain(response, chunk);
          continue;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
        continue;
      }
      await writeWithDrain(response, chunk);
    }
    if (!committed) {
      const original = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const encoding = typeof headers['content-encoding'] === 'string'
        ? headers['content-encoding'].trim().toLowerCase()
        : undefined;
      const decoded = decodeHtmlBody(original, encoding);
      const injected = decoded !== null && decoded.byteLength <= MAX_INJECT_DECODED_BYTES
        ? injectGuestPill(decoded)
        : null;
      if (injected === null) {
        response.writeHead(status, headers);
        await writeWithDrain(response, original);
      } else {
        const injectedHeaders = { ...headers };
        delete injectedHeaders['content-encoding'];
        delete injectedHeaders['content-length'];
        injectedHeaders['content-length'] = String(injected.byteLength);
        response.writeHead(status, injectedHeaders);
        await writeWithDrain(response, injected);
      }
    }
    if (!response.writableEnded && !response.destroyed) response.end();
    return 'sent';
  } catch (error) {
    if (!response.headersSent) response.destroy(error instanceof Error ? error : new Error('guest html failed'));
    else response.destroy(error instanceof Error ? error : new Error('guest html failed'));
    return 'failed';
  }
}

function headersToRecord(pairs: HeaderPair[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of pairs) {
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[name] = [existing, value];
  }
  return out;
}

export async function proxyDeviceHttp(input: DeviceHttpRequest): Promise<void> {
  const { config, tunnels, device, request, response, publicOrigin } = input;
  const path = `${input.rest}${input.search}`;
  try {
    assertSafeOriginPath(path);
  } catch (error) {
    sendErrorPage(response, 400, 'Bad request', error instanceof Error ? error.message : 'invalid path');
    return;
  }

  const tunnel = tunnels.get(device.id);
  if (tunnel === undefined) {
    sendErrorPage(response, 503, 'Device offline', 'The device is not connected to the edge.', { 'retry-after': '5' });
    return;
  }

  const method = (request.method ?? 'GET').toUpperCase();
  let headers = filterRequestHeaders(request.headers);
  // Guest HTML must reach the injector uncompressed. DSH honours
  // Accept-Encoding even for documents; ask for identity only on guest
  // navigations, leaving assets and APIs compressed.
  if (input.guest === true) {
    const accept = headers.find(([name]) => name.toLowerCase() === 'accept')?.[1] ?? '';
    if (accept.includes('text/html')) {
      headers = headers.filter(([name]) => name.toLowerCase() !== 'accept-encoding');
    }
  }
  const priority = classifyPriority(input.rest, headers, 'http');
  let stream;
  try {
    stream = tunnel.attached.mux.open({
      kind: 'http',
      method,
      path,
      headers,
      priority,
      requestId: newId('req', 8),
    });
  } catch (error) {
    input.logger.warn('failed to open mux stream', { deviceId: device.id, error });
    if (isStreamLimitError(error)) {
      // The tunnel is healthy but at its 256-stream ceiling. Tell clients to
      // retry shortly instead of treating it as a dead device.
      const headers = { 'retry-after': '1' };
      if (wantsJson(request, input.rest)) {
        sendJson(response, 503, { error: 'STREAM_LIMIT', retryable: true, retryAfterSeconds: 1 }, headers);
      } else {
        sendErrorPage(response, 503, 'Too many requests', 'The device tunnel is at its stream limit. Retry in a moment.', headers);
      }
      return;
    }
    sendErrorPage(response, 502, 'Tunnel unavailable', 'The device tunnel closed before the request started.');
    return;
  }

  let finished = false;
  const onClientClose = (): void => {
    if (finished || response.writableEnded) return;
    stream.reset('CLIENT_ABORTED', 'browser closed the connection', true);
  };
  response.on('close', onClientClose);

  const bodyForward = (async (): Promise<void> => {
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk as Uint8Array);
        await stream.write(bytes);
      }
      await stream.end();
    } catch {
      /* the stream was reset or the browser aborted; the head path reports it */
    }
  })();

  try {
    const head = await stream.head();
    if (response.destroyed) return;
    if (head.status < 200 || head.status > 599) {
      stream.reset('UPSTREAM_BAD_STATUS', `upstream sent status ${String(head.status)}`);
      sendErrorPage(response, 502, 'Bad upstream response', 'The device returned an invalid HTTP status.');
      return;
    }
    // Relative public base: no Host/forwarded-header trust needed in the
    // redirect, and the browser resolves it against the edge origin.
    const publicBase = `${DEVICE_MOUNT_PREFIX}${device.id}`;
    const filtered = filterResponseHeaders(head.headers).map(([name, value]) =>
      name.toLowerCase() === 'location' ? (['location', rewriteLoopbackLocation(value, publicBase)] as HeaderPair) : ([name, value] as HeaderPair),
    );
    const headersRecord = headersToRecord(filtered);
    // Node requires a valid status message; let it use the default text.
    if (head.bodyless === true || method === 'HEAD') {
      response.writeHead(head.status, headersRecord);
      finished = true;
      response.end();
      return;
    }

    // Guest HTML gets a fixed Disconnect pill. This path buffers at most 2 MiB;
    // larger documents and compressed responses stream through untouched.
    const contentType = headerValueOf(filtered, 'content-type') ?? '';
    const injectGuestPillIntoHtml = input.guest === true
      && head.status >= 200
      && head.status <= 299
      && contentType.toLowerCase().includes('text/html');
    if (injectGuestPillIntoHtml) {
      finished = true;
      await streamGuestHtml(stream, response, head.status, headersRecord);
      return;
    }

    response.writeHead(head.status, headersRecord);
    try {
      for await (const chunk of stream.body()) {
        if (response.destroyed) break;
        await writeWithDrain(response, chunk);
      }
    } catch (error) {
      if (!response.headersSent) {
        sendErrorPage(response, 502, 'Upstream error', error instanceof Error ? error.message : 'the device stream failed');
      } else {
        response.destroy(error instanceof Error ? error : new Error('upstream stream failed'));
      }
      return;
    }
    finished = true;
    if (!response.writableEnded && !response.destroyed) response.end();
  } catch (error) {
    if (finished || response.destroyed) return;
    if (!response.headersSent) {
      sendErrorPage(response, 502, 'Device unreachable', error instanceof Error ? error.message : 'the device did not answer');
    } else {
      response.destroy(error instanceof Error ? error : new Error('proxied response failed'));
    }
  } finally {
    response.off('close', onClientClose);
    void bodyForward;
  }
}
