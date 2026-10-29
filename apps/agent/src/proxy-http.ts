/**
 * HTTP stream proxy: one edge stream ⇄ one loopback `http.request`.
 *
 * The browser's headers are re-built from an allow-list (no Cookie, no
 * Authorization, no forwarding headers), the agent's own DSH cookie is
 * attached, the body is streamed as DATA frames, and the response is streamed
 * back as HEAD + DATA + END with real backpressure. A RESET destroys the
 * upstream request so DSH stops working immediately.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { assertSafeOriginPath, filterRequestHeaders, filterResponseHeaders, type HeaderPair, type Open } from '@dsh-rc/protocol';
import type { Stream } from '@dsh-rc/mux';
import type { Logger } from '@dsh-rc/shared';
import { AgentError, DshAuthError, messageOf } from './errors.js';
import type { DshSession, DshTarget } from './dsh-session.js';
import { toBytes, writeWithDrain } from './io.js';

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface UpstreamReporter {
  /** The upstream asked for a credential the agent does not have. */
  authRequired(message: string): void;
  /** An authenticated upstream response succeeded. */
  healthy(): void;
}

export interface HttpProxyDeps {
  target: DshTarget;
  session: DshSession;
  logger?: Logger;
  reporter: UpstreamReporter;
  maxBodyBytes?: number;
  connectTimeoutMs?: number;
}

class BodyTooLargeError extends Error {}

const PATH_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/**
 * Validate the path a second time; a compromised edge must not escape
 * origin-form. Percent-decoding is applied exactly once (never recursively):
 * double-encoded input is rejected outright, and a decoded form that
 * introduces traversal, separators or control characters is rejected too.
 */
export function assertProxyPath(path: string): void {
  assertSafeOriginPath(path);
  if (path.includes('%25')) {
    throw new AgentError('PROTOCOL_BAD_FRAME', 'path contains double-encoded input', false);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new AgentError('PROTOCOL_BAD_FRAME', 'path contains invalid percent-encoding', false);
  }
  if (decoded === path) return;
  if (decoded.includes('..')) {
    throw new AgentError('PROTOCOL_BAD_FRAME', 'path contains encoded traversal', false);
  }
  if (decoded.includes('\\')) {
    throw new AgentError('PROTOCOL_BAD_FRAME', 'path contains an encoded backslash', false);
  }
  if (PATH_CONTROL_CHAR_RE.test(decoded)) {
    throw new AgentError('PROTOCOL_BAD_FRAME', 'path contains encoded control characters', false);
  }
  const countSlashes = (value: string): number => (value.match(/\//g) ?? []).length;
  if (countSlashes(decoded) > countSlashes(path)) {
    throw new AgentError('PROTOCOL_BAD_FRAME', 'path contains an encoded separator', false);
  }
}

/** Set by the agent on every proxied request; the host plugin narrows its API for these. */
export const VIA_EDGE_HEADER = 'x-dsh-rc-via';

/**
 * Build the upstream header set: allow-listed browser headers, loopback Host,
 * and the agent's in-memory DSH cookie. The browser's Cookie/Authorization
 * were already dropped by `filterRequestHeaders`.
 */
export function buildUpstreamHeaders(open: Open, target: DshTarget, cookie: string | undefined): OutgoingHttpHeaders {
  const pairs: HeaderPair[] = filterRequestHeaders(open.headers);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of pairs) {
    // Never forward a client-declared body framing/expectation: the agent
    // re-streams the body, so Node must frame it (otherwise CL desync/smuggling).
    if (name === 'host' || name === 'cookie' || name === 'content-length' || name === 'expect') continue;
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  headers['host'] = target.hostHeader;
  if (cookie !== undefined && cookie !== '') headers['cookie'] = cookie;
  // Trusted marker: this request came through the edge, not the local window.
  // filterRequestHeaders drops any client-supplied x-dsh-rc-* first.
  headers[VIA_EDGE_HEADER] = 'edge';
  return headers;
}

interface UpstreamAttempt {
  request: ClientRequest;
  response: Promise<IncomingMessage>;
}

/** One upstream attempt. The body is pumped by the caller for the first try. */
function startUpstream(
  open: Open,
  deps: HttpProxyDeps,
  headers: OutgoingHttpHeaders,
): UpstreamAttempt {
  const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let responseSettled = false;

  const request = (deps.target.protocol === 'https:' ? httpsRequest : httpRequest)({
    protocol: deps.target.protocol,
    hostname: deps.target.host,
    port: deps.target.port,
    method: open.method,
    path: open.path,
    headers,
  });

  const clearConnectTimer = (): void => {
    if (connectTimer !== undefined) {
      clearTimeout(connectTimer);
      connectTimer = undefined;
    }
  };
  connectTimer = setTimeout(() => {
    if (responseSettled) return;
    request.destroy(new AgentError('UPSTREAM_TIMEOUT', 'timed out connecting to the DSH web server', true));
  }, connectTimeoutMs);
  connectTimer.unref?.();
  request.once('socket', (socket) => {
    if (socket.connecting) socket.once('connect', clearConnectTimer);
    else clearConnectTimer();
  });
  request.once('response', clearConnectTimer);
  request.once('close', clearConnectTimer);

  const response = new Promise<IncomingMessage>((resolve, reject) => {
    request.once('response', (incoming) => {
      responseSettled = true;
      resolve(incoming);
    });
    request.once('error', (error) => {
      responseSettled = true;
      reject(error);
    });
  });
  // Errors are observed through `response`; this listener only prevents an
  // unhandled 'error' event if the promise was already resolved.
  request.on('error', () => undefined);

  return { request, response };
}

/** Stream the edge request body into the upstream request with backpressure. */
async function pumpRequestBody(stream: Stream, request: ClientRequest, maxBytes: number): Promise<void> {
  let total = 0;
  for await (const chunk of stream.body()) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new BodyTooLargeError(`request body exceeds ${String(maxBytes)} bytes`);
    await writeWithDrain(request, chunk);
  }
  request.end();
}

function rejectStream(
  stream: Stream,
  status: number,
  message: string,
  code: string,
  retryable: boolean,
  logger?: Logger,
): void {
  if (stream.isClosed) return;
  try {
    stream.sendOpenAck({ ok: false, status, message });
    stream.reset(code, message, retryable);
  } catch (error) {
    logger?.debug('could not reject stream cleanly', { error });
  }
}

export function handleHttpStream(stream: Stream, open: Open, deps: HttpProxyDeps): void {
  void proxyHttpStream(stream, open, deps).catch((error: unknown) => {
    const message = messageOf(error);
    deps.logger?.warn('http proxy failed', { path: open.path, error });
    if (!stream.isClosed) {
      try {
        stream.end({ error: { code: 'UPSTREAM_ERROR', message } });
      } catch {
        /* stream already gone */
      }
    }
  });
}

async function proxyHttpStream(stream: Stream, open: Open, deps: HttpProxyDeps): Promise<void> {
  if (stream.isClosed) return;
  const logger = deps.logger;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  try {
    assertProxyPath(open.path);
  } catch (error) {
    logger?.warn('rejected unsafe path from edge', { path: open.path, error });
    rejectStream(stream, 400, messageOf(error), 'PROTOCOL_BAD_FRAME', false, logger);
    return;
  }

  // Subscribe before the first await. A client RESET may arrive while the
  // token exchange or a 401 refresh is in flight; it must abort the proxy and
  // must never let the code below start a second upstream request.
  let aborted = false;
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  const onReset = (): void => {
    aborted = true;
    request?.destroy();
    response?.destroy();
  };
  const unsubscribe = stream.onReset(onReset);

  try {
    let cookie: string | undefined;
    try {
      cookie = await deps.session.cookie();
    } catch (error) {
      if (aborted || stream.isClosed) return;
      const message = error instanceof DshAuthError ? error.message : `DSH is not reachable: ${messageOf(error)}`;
      deps.reporter.authRequired(message);
      rejectStream(stream, 502, message, error instanceof DshAuthError ? 'DSH_AUTH_REQUIRED' : 'UPSTREAM_UNREACHABLE', !(error instanceof DshAuthError), logger);
      return;
    }
    if (aborted || stream.isClosed) return;

    let headers = buildUpstreamHeaders(open, deps.target, cookie);
    let attempt = startUpstream(open, deps, headers);
    request = attempt.request;

    const pump = pumpRequestBody(stream, attempt.request, maxBodyBytes);
    // Surface body errors through the request; response errors arrive through `response`.
    void pump.catch((error: unknown) => {
      attempt.request.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    let incoming = await attempt.response;
    if (aborted || stream.isClosed) {
      incoming.destroy();
      return;
    }
    response = incoming;

    // On 401: GET/HEAD can be replayed after a cookie refresh; a body-bearing
    // request cannot (we never buffer bodies), so refresh for the next request
    // and let this 401 through.
    let refreshAttempted = false;
    let refreshSucceeded = false;
    let retriedAfterRefresh = false;
    if (incoming.statusCode === 401 && !aborted && deps.session.canAuthenticate) {
      const replayable = open.method === 'GET' || open.method === 'HEAD';
      if (replayable) {
        incoming.resume();
        refreshAttempted = true;
        refreshSucceeded = await deps.session.refresh();
        if (aborted || stream.isClosed) return;
        if (refreshSucceeded) {
          const refreshedCookie = await deps.session.cookie();
          if (aborted || stream.isClosed) return;
          headers = buildUpstreamHeaders(open, deps.target, refreshedCookie);
          attempt = startUpstream(open, deps, headers);
          request = attempt.request;
          attempt.request.end();
          incoming = await attempt.response;
          if (aborted || stream.isClosed) {
            incoming.destroy();
            return;
          }
          response = incoming;
          retriedAfterRefresh = true;
        }
      } else {
        refreshAttempted = true;
        const bodyDetail = 'DSH rejected the session cookie (HTTP 401)';
        void deps.session.refresh().then((refreshed) => {
          if (!refreshed) deps.reporter.authRequired(deps.session.markAuthRequired(bodyDetail));
        });
      }
    }

    if (incoming.statusCode === 401) {
      const detail = deps.session.canAuthenticate
        ? 'DSH rejected the session cookie (HTTP 401)'
        : 'DSH rejected the request because no launch token was available';
      if (!deps.session.canAuthenticate || retriedAfterRefresh || (refreshAttempted && !refreshSucceeded)) {
        deps.reporter.authRequired(deps.session.markAuthRequired(detail));
      }
    } else {
      if (deps.session.hasCookie) {
        deps.session.markHealthy();
        deps.reporter.healthy();
      }
    }

    const status = incoming.statusCode ?? 502;
    const bodyless = open.method === 'HEAD' || status === 204 || status === 304;
    stream.sendHead({
      status,
      ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
      headers: filterResponseHeaders(Object.entries(incoming.headers)),
      ...(bodyless ? { bodyless: true } : {}),
    });

    if (bodyless) {
      incoming.resume();
      await stream.end();
      return;
    }

    try {
      for await (const chunk of incoming) {
        if (aborted || stream.isClosed) {
          incoming.destroy();
          return;
        }
        await stream.write(toBytes(chunk));
      }
      await stream.end();
    } catch (error) {
      incoming.destroy();
      if (!stream.isClosed) {
        await stream.end({ error: { code: 'UPSTREAM_ERROR', message: messageOf(error) } });
      }
    }
  } catch (error) {
    if (aborted || stream.isClosed) return;
    if (error instanceof BodyTooLargeError) {
      request?.destroy();
      rejectStream(stream, 413, error.message, 'PAYLOAD_TOO_LARGE', false, logger);
      return;
    }
    const timedOut = error instanceof AgentError && error.code === 'UPSTREAM_TIMEOUT';
    const message = `DSH web server is not reachable: ${messageOf(error)}`;
    logger?.warn('upstream request failed', { path: open.path, error });
    rejectStream(stream, timedOut ? 504 : 502, message, timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE', true, logger);
  } finally {
    unsubscribe();
  }
}
