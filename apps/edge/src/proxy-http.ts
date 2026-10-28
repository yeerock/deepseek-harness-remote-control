/**
 * HTTP proxying for `/d/<deviceId>/*`.
 *
 * The edge is a byte pump with policy: it filters headers in both directions,
 * opens one mux stream per request, streams the body with real backpressure
 * (writeWithDrain -> mux credit), rewrites absolute loopback redirects and
 * never forwards browser credentials to the agent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
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
  const headers = filterRequestHeaders(request.headers);
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
    response.writeHead(head.status, headersRecord);
    if (head.bodyless === true || method === 'HEAD') {
      finished = true;
      response.end();
      return;
    }
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
