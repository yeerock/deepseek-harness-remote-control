/**
 * WebSocket proxying for `/d/<deviceId>/*`.
 *
 * The browser upgrade is deliberately held open while the agent connects
 * upstream: the edge only completes the 101 after OPEN_ACK.ok, so a failed
 * upstream handshake becomes a plain HTTP error instead of a half-open socket.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  MAX_WS_STREAM_BUDGET_BYTES,
  WsOpcode,
  assertSafeOriginPath,
  decodeCloseBody,
  filterRequestHeaders,
} from '@dsh-rc/protocol';
import type { Mux, Stream } from '@dsh-rc/mux';
import { newId, type Logger } from '@dsh-rc/shared';
import type { EdgeConfig } from './config.js';
import type { DeviceRow } from './db.js';
import type { TunnelManager } from './tunnels.js';
import { isStreamLimitError } from './proxy-http.js';
import { rejectUpgrade, toBytes } from './upgrade.js';

/**
 * Backpressure limits for the browser side of a WebSocket stream.
 *
 * ws.send() queues without bound when the peer stops reading; 16 MiB is already
 * far more than any DSH frame needs. The tunnel-side limit mirrors the mux's
 * queued-frame ceiling so a browser cannot stuff an unbounded number of frames
 * into the outbound scheduler either.
 */
export const MAX_BROWSER_WS_BUFFERED_BYTES = 16 * 1024 * 1024;
export const MAX_TUNNEL_QUEUED_FRAMES = 1024;
export const WS_BACKPRESSURE = 'WS_BACKPRESSURE' as const;

export interface BackpressureAbort {
  code: typeof WS_BACKPRESSURE;
  reason: string;
  retryable: true;
}

/** Decision for the agent -> browser direction. */
export function browserBackpressureDecision(bufferedAmount: number): BackpressureAbort | undefined {
  if (bufferedAmount <= MAX_BROWSER_WS_BUFFERED_BYTES) return undefined;
  return { code: WS_BACKPRESSURE, reason: 'browser is not consuming websocket frames', retryable: true };
}

/** Decision for the browser -> agent direction (outbound mux scheduler). */
export function tunnelBackpressureDecision(queuedFrames: number): BackpressureAbort | undefined {
  if (queuedFrames <= MAX_TUNNEL_QUEUED_FRAMES) return undefined;
  return { code: WS_BACKPRESSURE, reason: 'tunnel outbound queue is saturated', retryable: true };
}

export function browserBackpressureExceeded(bufferedAmount: number): boolean {
  return browserBackpressureDecision(bufferedAmount) !== undefined;
}

export function tunnelBackpressureExceeded(queuedFrames: number): boolean {
  return tunnelBackpressureDecision(queuedFrames) !== undefined;
}

export interface DeviceWsRequest {
  config: EdgeConfig;
  logger: Logger;
  tunnels: TunnelManager;
  device: DeviceRow;
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  rest: string;
  search: string;
  browserWss: WebSocketServer;
}

function closeCodeForWire(code: number): number {
  // 1005/1006 are local-only statuses and cannot be put on the wire.
  return code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
}

export async function proxyDeviceWs(input: DeviceWsRequest): Promise<void> {
  const { tunnels, device, request, socket, head, browserWss } = input;
  const path = `${input.rest}${input.search}`;
  try {
    assertSafeOriginPath(path);
  } catch (error) {
    rejectUpgrade(socket, 400, error instanceof Error ? error.message : 'invalid path');
    return;
  }

  const tunnel = tunnels.get(device.id);
  if (tunnel === undefined) {
    rejectUpgrade(socket, 503, 'device offline', { 'retry-after': '5' });
    return;
  }

  let stream;
  try {
    stream = tunnel.attached.mux.open({
      kind: 'ws',
      method: (request.method ?? 'GET').toUpperCase(),
      path,
      headers: filterRequestHeaders(request.headers, { upgrade: true }),
      priority: 'high',
      requestId: newId('req', 8),
    });
  } catch (error) {
    input.logger.warn('failed to open websocket stream', { deviceId: device.id, error });
    if (isStreamLimitError(error)) {
      rejectUpgrade(socket, 503, 'the device tunnel is at its stream limit; retry shortly', { 'retry-after': '1' });
      return;
    }
    rejectUpgrade(socket, 502, 'tunnel unavailable');
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ack;
  try {
    ack = await Promise.race([
      stream.openAck(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('WS_OPEN_TIMEOUT')), input.config.wsOpenTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    stream.reset('WS_OPEN_TIMEOUT', error instanceof Error ? error.message : 'websocket open timed out', true);
    rejectUpgrade(socket, 504, 'the device did not open its upstream websocket in time');
    return;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!ack.ok) {
    stream.reset('UPSTREAM_REJECTED', ack.message ?? 'upstream websocket rejected', true);
    const status = ack.status !== undefined && ack.status >= 300 && ack.status <= 599 ? ack.status : 502;
    rejectUpgrade(socket, status, ack.message ?? 'the device could not open the upstream websocket');
    return;
  }

  // ws selects the subprotocol from the request header; narrow it to what the
  // agent actually negotiated so the 101 advertises the same value. Never
  // advertise a protocol the browser did not offer.
  const offered = request.headers['sec-websocket-protocol'];
  const offeredList = typeof offered === 'string' ? offered.split(',').map((value) => value.trim()) : [];
  if (typeof ack.protocol === 'string' && ack.protocol !== '' && offeredList.includes(ack.protocol)) {
    request.headers['sec-websocket-protocol'] = ack.protocol;
  } else {
    delete request.headers['sec-websocket-protocol'];
  }

  try {
    browserWss.handleUpgrade(request, socket, head, (ws) => {
      relay(ws, stream, tunnel.attached.mux, input);
    });
  } catch (error) {
    stream.reset('UPGRADE_FAILED', error instanceof Error ? error.message : 'browser upgrade failed', true);
    rejectUpgrade(socket, 400, 'invalid websocket handshake');
  }
}

function relay(ws: WebSocket, stream: Stream, mux: Mux, input: DeviceWsRequest): void {
  let budget = MAX_WS_STREAM_BUDGET_BYTES;
  let closed = false;

  const closeBrowser = (code: number, reason: string, force = false): void => {
    try {
      ws.close(closeCodeForWire(code), reason.slice(0, 120));
    } catch {
      ws.terminate();
      return;
    }
    if (!force) return;
    // A wedged peer may never finish the close handshake; drop the queued
    // frames shortly after so memory is actually released.
    const forced = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }, 250);
    forced.unref?.();
  };

  /** Abort both halves: reset the stream (retryable) and close the browser socket. */
  const abortBackpressure = (code: string, reason: string): void => {
    if (closed) return;
    closed = true;
    // If the tunnel already failed this stream there is nothing left to reset;
    // just close the browser side so its queued bytes are released.
    if (!stream.isClosed) stream.reset(code, reason, true);
    else input.logger.debug('backpressure abort after stream already closed', { deviceId: input.device.id, code });
    closeBrowser(1013, code, true);
  };

  const closeBoth = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    closeBrowser(closeCodeForWire(code), reason);
  };

  const offFrame = stream.onFrame((opcode, data) => {
    budget -= data.byteLength;
    if (budget < 0) {
      abortBackpressure('WS_STREAM_BUDGET', 'websocket stream exceeded its byte budget');
      return;
    }
    if (closed || ws.readyState !== 1) return;

    // Agent -> browser: never let a slow/paused browser grow edge memory.
    const browserAbort = browserBackpressureDecision(ws.bufferedAmount);
    if (browserAbort !== undefined) {
      abortBackpressure(browserAbort.code, browserAbort.reason);
      return;
    }

    switch (opcode) {
      case WsOpcode.Text:
        ws.send(Buffer.from(data), { binary: false });
        return;
      case WsOpcode.Binary:
        ws.send(Buffer.from(data), { binary: true });
        return;
      case WsOpcode.Close: {
        const body = decodeCloseBody(data);
        closeBoth(body.code, body.reason);
        void stream.end();
        return;
      }
      case WsOpcode.Ping:
        try {
          ws.ping(Buffer.from(data));
        } catch {
          /* socket gone */
        }
        return;
      case WsOpcode.Pong:
        try {
          ws.pong(Buffer.from(data));
        } catch {
          /* socket gone */
        }
        return;
      default:
        return;
    }
  });

  const offReset = stream.onReset((reset) => {
    closeBoth(1011, `${reset.code}: ${reset.message}`);
  });

  // The browser answers protocol-level pings inside the ws library; relay the
  // pong payload so DSH's liveness checks see an answer.
  ws.on('pong', (data) => {
    stream.sendFrame(WsOpcode.Pong, toBytes(data));
  });

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    const bytes = toBytes(data);
    budget -= bytes.byteLength;
    if (budget < 0) {
      abortBackpressure('WS_STREAM_BUDGET', 'websocket stream exceeded its byte budget');
      return;
    }
    // Browser -> agent: stop before the outbound mux queues grow without
    // bound. This is a byte-budgeted stream in reverse, not a normal path.
    const tunnelAbort = tunnelBackpressureDecision(mux.stats().queuedFrames);
    if (tunnelAbort !== undefined) {
      abortBackpressure(tunnelAbort.code, tunnelAbort.reason);
      return;
    }
    try {
      stream.sendFrame(isBinary ? WsOpcode.Binary : WsOpcode.Text, bytes);
    } catch (error) {
      // A single browser message larger than a tunnel frame cannot be framed;
      // fail the stream instead of letting the exception escape the ws handler.
      input.logger.warn('browser websocket frame could not be relayed', { deviceId: input.device.id, error });
      if (!closed) {
        closed = true;
        stream.reset('WS_FRAME_TOO_LARGE', error instanceof Error ? error.message : 'frame exceeds the tunnel ceiling', false);
        closeBrowser(1009, 'WS_FRAME_TOO_LARGE');
      }
    }
  });

  ws.on('close', (code, reason) => {
    offFrame();
    offReset();
    if (closed) return;
    closed = true;
    stream.sendClose(closeCodeForWire(code), reason.toString('utf8'));
    void stream.end();
  });

  ws.on('error', (error) => {
    input.logger.warn('browser websocket error', { deviceId: input.device.id, error });
    stream.reset('CLIENT_ABORTED', 'browser websocket errored', true);
  });
}
