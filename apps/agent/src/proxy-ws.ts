/**
 * WebSocket stream proxy: one edge WS stream ⇄ one loopback WebSocket.
 *
 * The edge defers the browser's 101 until the agent sends OPEN_ACK, so a failed
 * upstream handshake becomes a clean HTTP status at the edge instead of a
 * half-open socket. Frames are relayed both ways; close frames propagate; a
 * reset destroys the upstream socket.
 */
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { VIA_EDGE_HEADER } from './proxy-http.js';
import {
  MAX_FRAME_BYTES,
  decodeCloseBody,
  filterRequestHeaders,
  type Open,
  type WsOpcodeValue,
} from '@dsh-rc/protocol';
import type { Stream } from '@dsh-rc/mux';
import type { Logger } from '@dsh-rc/shared';
import { AgentError, DshAuthError, messageOf } from './errors.js';
import type { DshSession, DshTarget } from './dsh-session.js';
import { toBytes } from './io.js';
import { assertProxyPath, type UpstreamReporter } from './proxy-http.js';

export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface WsProxyDeps {
  target: DshTarget;
  session: DshSession;
  logger?: Logger;
  reporter: UpstreamReporter;
  handshakeTimeoutMs?: number;
}

/** Requested subprotocols, in browser preference order. */
export function requestedSubprotocols(open: Open): string[] {
  const protocols: string[] = [];
  for (const [name, value] of open.headers) {
    if (name.toLowerCase() !== 'sec-websocket-protocol') continue;
    for (const part of value.split(',')) {
      const protocol = part.trim();
      if (protocol !== '' && !protocols.includes(protocol)) protocols.push(protocol);
    }
  }
  return protocols.slice(0, 16);
}

/**
 * Rebuild the upgrade headers. `ws` generates Sec-WebSocket-Key/Version/
 * Extensions itself, and the subprotocol comes from the constructor argument,
 * so those are removed; everything else that survives the allow-list (user
 * agent, language, custom application headers) is forwarded.
 */
export function buildWsHeaders(open: Open, target: DshTarget, cookie: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of filterRequestHeaders(open.headers, { upgrade: true })) {
    if (name === 'host' || name === 'cookie') continue;
    if (name.startsWith('sec-websocket-')) continue;
    headers[name] = value;
  }
  headers['host'] = target.hostHeader;
  if (cookie !== undefined && cookie !== '') headers['cookie'] = cookie;
  headers[VIA_EDGE_HEADER] = 'edge';
  return headers;
}

function upstreamWsUrl(target: DshTarget, path: string): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${host}:${String(target.port)}${path}`;
}

export function handleWsStream(stream: Stream, open: Open, deps: WsProxyDeps): void {
  void proxyWsStream(stream, open, deps).catch((error: unknown) => {
    deps.logger?.warn('ws proxy failed', { path: open.path, error });
    if (!stream.isClosed) {
      try {
        stream.sendOpenAck({ ok: false, status: 502, message: messageOf(error) });
        stream.reset('UPSTREAM_ERROR', messageOf(error), true);
      } catch {
        /* stream already gone */
      }
    }
  });
}

async function proxyWsStream(stream: Stream, open: Open, deps: WsProxyDeps): Promise<void> {
  if (stream.isClosed) return;
  const logger = deps.logger;

  try {
    assertProxyPath(open.path);
  } catch (error) {
    logger?.warn('rejected unsafe ws path from edge', { path: open.path, error });
    stream.sendOpenAck({ ok: false, status: 400, message: messageOf(error) });
    stream.reset('PROTOCOL_BAD_FRAME', messageOf(error), false);
    return;
  }

  let cookie: string | undefined;
  try {
    cookie = await deps.session.cookie();
  } catch (error) {
    const message = error instanceof DshAuthError ? error.message : `DSH is not reachable: ${messageOf(error)}`;
    deps.reporter.authRequired(message);
    stream.sendOpenAck({ ok: false, status: 502, message });
    stream.reset(error instanceof DshAuthError ? 'DSH_AUTH_REQUIRED' : 'UPSTREAM_UNREACHABLE', message, !(error instanceof DshAuthError));
    return;
  }

  const protocols = requestedSubprotocols(open);
  const timeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
  let phase: 'connecting' | 'open' | 'closed' = 'connecting';
  let current: WebSocket | undefined;

  const finishClose = (socket: WebSocket | undefined): void => {
    phase = 'closed';
    socket?.terminate();
    unsubscribeReset();
    unsubscribeEnd();
  };

  const connect = (attempt: number): void => {
    if (phase !== 'connecting' || stream.isClosed) return;
    let settled = false;
    const headers = buildWsHeaders(open, deps.target, cookie);
    const options = {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
      maxPayload: MAX_FRAME_BYTES,
      rejectUnauthorized: false,
    } as const;
    const socket = protocols.length > 0
      ? new WebSocket(upstreamWsUrl(deps.target, open.path), protocols, options)
      : new WebSocket(upstreamWsUrl(deps.target, open.path), options);
    current = socket;

    const sendFailure = (status: number, message: string, retryable: boolean): void => {
      if (phase !== 'connecting' || stream.isClosed) return;
      phase = 'closed';
      try {
        stream.sendOpenAck({ ok: false, status, message });
        stream.reset(retryable ? 'UPSTREAM_UNREACHABLE' : 'UPSTREAM_HANDSHAKE_FAILED', message, retryable);
      } catch {
        /* stream already gone */
      }
      unsubscribeReset();
      unsubscribeEnd();
    };

    const failHandshake = (status: number, message: string, retryable: boolean): void => {
      if (settled || phase !== 'connecting') return;
      settled = true;
      socket.terminate();
      sendFailure(status, message, retryable);
    };

    socket.once('unexpected-response', (request: ClientRequest, response: IncomingMessage) => {
      const status = response.statusCode ?? 502;
      response.resume();
      request.destroy();
      if (settled) return;
      settled = true;
      const detail = `DSH rejected the WebSocket handshake (HTTP ${String(status)})`;

      if (status === 401 && attempt === 0 && deps.session.canAuthenticate && !stream.isClosed) {
        void deps.session.refresh().then((refreshed) => {
          if (stream.isClosed || phase !== 'connecting') return;
          if (!refreshed) {
            deps.reporter.authRequired(deps.session.markAuthRequired(detail));
            sendFailure(status, deps.session.authError ?? detail, false);
            socket.terminate();
            return;
          }
          void deps.session.cookie().then((fresh) => {
            if (stream.isClosed || phase !== 'connecting') return;
            cookie = fresh;
            connect(attempt + 1);
          }).catch((error: unknown) => {
            sendFailure(502, `could not refresh the DSH cookie: ${messageOf(error)}`, true);
            socket.terminate();
          });
        });
        return;
      }

      if (status === 401) deps.reporter.authRequired(deps.session.markAuthRequired(detail));
      sendFailure(status, detail, status >= 500 || status === 429);
      socket.terminate();
    });

    socket.once('open', () => {
      if (settled || stream.isClosed) {
        socket.terminate();
        return;
      }
      settled = true;
      phase = 'open';
      if (deps.session.hasCookie) {
        deps.session.markHealthy();
        deps.reporter.healthy();
      }
      logger?.debug('upstream websocket open', { path: open.path, protocol: socket.protocol });
      stream.sendOpenAck({
        ok: true,
        ...(socket.protocol === '' ? {} : { protocol: socket.protocol }),
      });

      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (phase !== 'open') return;
        try {
          stream.sendFrame(isBinary ? 2 : 1, toBytes(data));
        } catch (error) {
          logger?.warn('could not relay upstream websocket frame', { error });
          phase = 'closed';
          stream.reset('WS_STREAM_BUDGET', messageOf(error), true);
          socket.terminate();
        }
      });
      socket.on('ping', (data: Buffer) => {
        if (phase === 'open') stream.sendFrame(9, toBytes(data));
      });
      socket.on('pong', (data: Buffer) => {
        if (phase === 'open') stream.sendFrame(10, toBytes(data));
      });
      socket.on('close', (code: number, reason: Buffer) => {
        if (phase === 'closed') return;
        phase = 'closed';
        const text = reason.toString('utf8');
        stream.sendClose(code, text);
        void stream.end();
        unsubscribeReset();
        unsubscribeEnd();
      });
    });

    socket.once('error', (error: Error) => {
      if (phase === 'open') {
        phase = 'closed';
        stream.reset('UPSTREAM_ERROR', messageOf(error), true);
        unsubscribeReset();
        unsubscribeEnd();
        return;
      }
      if (settled) return;
      failHandshake(502, `could not open the DSH WebSocket: ${messageOf(error)}`, true);
    });

    socket.once('close', () => {
      if (phase === 'connecting' && !settled) {
        failHandshake(502, 'the DSH WebSocket closed during the handshake', true);
      }
    });
  };

  stream.onFrame((opcode: WsOpcodeValue, data: Uint8Array) => {
    const socket = current;
    if (phase !== 'open' || socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    switch (opcode) {
      case 1:
        socket.send(data, { binary: false });
        break;
      case 2:
        socket.send(data, { binary: true });
        break;
      case 8: {
        const { code, reason } = decodeCloseBody(data);
        phase = 'closed';
        socket.close(code, reason);
        void stream.end();
        unsubscribeReset();
        unsubscribeEnd();
        break;
      }
      case 9:
        socket.ping(data);
        break;
      case 10:
        socket.pong(data);
        break;
      default:
        break;
    }
  });

  const unsubscribeReset = stream.onReset(() => {
    finishClose(current);
  });
  const unsubscribeEnd = (): void => {
    if (phase !== 'open') return;
    phase = 'closed';
    current?.close(1000, 'edge ended the stream');
    unsubscribeReset();
  };
  void stream.waitForEnd().then(unsubscribeEnd);

  connect(0);
  logger?.debug('ws stream opened', { path: open.path });
}