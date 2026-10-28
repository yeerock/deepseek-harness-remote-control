/**
 * Tunnel client: one outbound WebSocket to the edge, HELLO/HELLO_ACK, then a
 * mux that carries every HTTP/WebSocket stream.
 *
 * `packages/mux` does not dispatch HELLO/HELLO_ACK frames, so the handshake is
 * done on the raw socket and the mux is attached only after the edge accepted
 * us. Frames that arrive between HELLO_ACK and `attachMux` are buffered and
 * replayed, so an edge that pipelines the first OPEN cannot race us.
 */
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { attachMux, platformLabel, VERSION, type AttachedSocket, type Logger } from '@dsh-rc/shared';
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  INITIAL_STREAM_WINDOW,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  FrameType,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  isHelloAck,
  type Hello,
  type HelloAck,
} from '@dsh-rc/protocol';
import type { Mux, Stream } from '@dsh-rc/mux';
import { AgentError, HelloRejectedError, describeCloseCode, isTerminalHelloCode, isTerminalCloseCode, messageOf } from './errors.js';
import { toBytes } from './io.js';

export interface TunnelCloseInfo {
  code: number;
  reason: string;
  at: number;
}

export interface TunnelConnection {
  readonly mux: Mux;
  readonly socket: WebSocket;
  readonly closed: Promise<TunnelCloseInfo>;
  /** Graceful close (mux close 1000 + socket close). */
  close(code?: number, reason?: string): void;
  /** Hard stop for shutdown when the graceful close stalls. */
  terminate(): void;
}

export interface TunnelOptions {
  deviceId: string;
  deviceSecret: string;
  tunnelUrl: string;
  insecure: boolean;
  logger?: Logger;
  onStream(stream: Stream): void;
  connectTimeoutMs?: number;
}

export const HELLO_HEARTBEAT_MIN_MS = 1_000;
export const HELLO_HEARTBEAT_MAX_MS = 120_000;
export const HELLO_IDLE_MAX_MS = 300_000;
export const STREAM_WINDOW_MIN_BYTES = 16_384;
export const STREAM_WINDOW_MAX_BYTES = 8_388_608;
export const PREATTACH_MAX_FRAMES = 64;
export const PREATTACH_MAX_BYTES = 256 * 1024;

export interface HelloLimits {
  heartbeatMs: number;
  idleTimeoutMs: number;
  initialStreamWindow: number;
}

/**
 * Validate the resource values in HELLO_ACK before they reach the mux. A zero
 * heartbeat or window would disable supervision/flow control, and an oversized
 * idle timeout would hide a dead edge for minutes.
 */
export function validateHelloAckLimits(ack: {
  heartbeatMs: number;
  idleTimeoutMs: number;
  initialStreamWindow: number;
}): HelloLimits {
  const heartbeatMs = ack.heartbeatMs === 0 ? DEFAULT_HEARTBEAT_MS : ack.heartbeatMs;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < HELLO_HEARTBEAT_MIN_MS || heartbeatMs > HELLO_HEARTBEAT_MAX_MS) {
    throw new AgentError('PROTOCOL_BAD_FRAME', `HELLO_ACK heartbeatMs out of range: ${String(ack.heartbeatMs)}`, false);
  }
  const idleTimeoutMs = ack.idleTimeoutMs === 0 ? DEFAULT_IDLE_TIMEOUT_MS : ack.idleTimeoutMs;
  if (
    !Number.isInteger(idleTimeoutMs) ||
    idleTimeoutMs < heartbeatMs * 3 ||
    idleTimeoutMs > HELLO_IDLE_MAX_MS
  ) {
    throw new AgentError('PROTOCOL_BAD_FRAME', `HELLO_ACK idleTimeoutMs out of range: ${String(ack.idleTimeoutMs)}`, false);
  }
  const initialStreamWindow = ack.initialStreamWindow === 0 ? INITIAL_STREAM_WINDOW : ack.initialStreamWindow;
  if (
    !Number.isInteger(initialStreamWindow) ||
    initialStreamWindow < STREAM_WINDOW_MIN_BYTES ||
    initialStreamWindow > STREAM_WINDOW_MAX_BYTES
  ) {
    throw new AgentError('PROTOCOL_BAD_FRAME', `HELLO_ACK initialStreamWindow out of range: ${String(ack.initialStreamWindow)}`, false);
  }
  return { heartbeatMs, idleTimeoutMs, initialStreamWindow };
}

/** Cap the frames buffered between HELLO_ACK and attachMux (L4). */
export function checkPreAttachBuffer(frameCount: number, byteCount: number): void {
  if (frameCount > PREATTACH_MAX_FRAMES || byteCount > PREATTACH_MAX_BYTES) {
    throw new AgentError('PROTOCOL_BAD_FRAME', 'edge flooded frames before the mux was attached', false);
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('unexpected-response', onUnexpectedResponse);
      clearTimeout(timer);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onOpen = (): void => {
      finish();
    };
    const onError = (error: Error): void => {
      finish(new AgentError('TUNNEL_UNREACHABLE', `could not reach the edge tunnel: ${error.message}`, true));
    };
    const onClose = (code: number, reason: Buffer): void => {
      finish(
        new AgentError(
          'TUNNEL_CLOSED',
          `edge closed during the WebSocket upgrade (${String(code)}): ${reason.toString('utf8')}`,
          !isTerminalCloseCode(code),
        ),
      );
    };
    const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage): void => {
      const status = response.statusCode ?? 0;
      response.resume();
      const retryable = status !== 401 && status !== 403 && status !== 404;
      finish(new AgentError('TUNNEL_UPGRADE_REJECTED', `edge rejected the tunnel upgrade (HTTP ${String(status)})`, retryable));
      socket.terminate();
    };
    const timer = setTimeout(() => {
      finish(new AgentError('TUNNEL_TIMEOUT', 'timed out opening the edge tunnel', true));
      socket.terminate();
    }, timeoutMs);
    timer.unref?.();
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

interface HandshakeResult {
  ack: HelloAck;
  /** Frames that arrived after HELLO_ACK but before the mux took over. */
  buffered: Uint8Array[];
  detach(): void;
  /** Set when the pre-attach buffer cap was exceeded. */
  overflow: { error?: AgentError };
}

function performHandshake(socket: WebSocket, hello: Hello): Promise<HandshakeResult> {
  return new Promise<HandshakeResult>((resolve, reject) => {
    const buffered: Uint8Array[] = [];
    const overflow: { error?: AgentError } = {};
    let bufferedBytes = 0;
    let acknowledged = false;
    let settled = false;

    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onMessage = (data: RawData, isBinary: boolean): void => {
      const bytes = toBytes(data);
      if (acknowledged) {
        buffered.push(bytes);
        bufferedBytes += bytes.byteLength;
        try {
          checkPreAttachBuffer(buffered.length, bufferedBytes);
        } catch (error) {
          overflow.error = error instanceof AgentError ? error : new AgentError('PROTOCOL_BAD_FRAME', messageOf(error), false);
          buffered.length = 0;
          socket.terminate();
        }
        return;
      }
      if (!isBinary) {
        fail(new AgentError('PROTOCOL_TEXT_FRAME', 'edge sent a text frame during the tunnel handshake', false));
        return;
      }
      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch (error) {
        fail(new AgentError('PROTOCOL_BAD_FRAME', `malformed frame during handshake: ${messageOf(error)}`, false));
        return;
      }
      if (frame.type !== FrameType.HelloAck) {
        fail(new AgentError('PROTOCOL_BAD_FRAME', `unexpected frame type ${String(frame.type)} before HELLO_ACK`, false));
        return;
      }
      let value: HelloAck;
      try {
        value = decodeJson(frame.payload, isHelloAck);
      } catch (error) {
        fail(new AgentError('PROTOCOL_BAD_FRAME', `invalid HELLO_ACK: ${messageOf(error)}`, false));
        return;
      }
      acknowledged = true;
      settled = true;
      resolve({ ack: value, buffered, detach: cleanup, overflow });
    };

    const onClose = (code: number, reason: Buffer): void => {
      fail(
        new AgentError(
          'TUNNEL_CLOSED',
          `edge closed the tunnel during the handshake (${String(code)}): ${reason.toString('utf8')}`,
          !isTerminalCloseCode(code),
        ),
      );
    };

    socket.on('message', onMessage);
    socket.on('close', onClose);
    try {
      socket.send(encodeFrame(FrameType.Hello, 0, encodeJson(hello)), { binary: true }, (error) => {
        if (error) fail(new AgentError('TUNNEL_UNREACHABLE', `could not send HELLO: ${error.message}`, true));
      });
    } catch (error) {
      fail(new AgentError('TUNNEL_UNREACHABLE', `could not send HELLO: ${messageOf(error)}`, true));
    }
  });
}

/**
 * Open one tunnel and complete HELLO. Rejects with an `AgentError` whose
 * `retryable` flag tells the supervisor whether to reconnect or stop.
 */
export async function openTunnel(options: TunnelOptions): Promise<TunnelConnection> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const socket = new WebSocket(options.tunnelUrl, {
    headers: { authorization: `Bearer ${options.deviceSecret}` },
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    handshakeTimeout: connectTimeoutMs,
    rejectUnauthorized: !options.insecure,
  });

  try {
    await waitForOpen(socket, connectTimeoutMs);
  } catch (error) {
    socket.terminate();
    throw error;
  }

  // Record the close frame even if it lands in the tiny window between
  // HELLO_ACK and attachMux; otherwise a socket that closes immediately after
  // accepting us would never fail the mux and the supervisor would wait forever.
  let lastClose: { code: number; reason: string } | undefined;
  const recordClose = (code: number, reason: Buffer): void => {
    lastClose = { code, reason: reason.toString('utf8') };
  };
  socket.on('close', recordClose);

  const hello: Hello = {
    protocol: PROTOCOL_VERSION,
    deviceId: options.deviceId,
    token: options.deviceSecret,
    agentVersion: VERSION,
    platform: platformLabel(),
    maxFrameBytes: MAX_FRAME_BYTES,
  };

  const handshake = await performHandshake(socket, hello).catch((error: unknown) => {
    socket.terminate();
    throw error;
  });

  if (handshake.overflow.error !== undefined) {
    handshake.detach();
    socket.terminate();
    throw handshake.overflow.error;
  }

  if (!handshake.ack.ok) {
    handshake.detach();
    socket.terminate();
    const ack = handshake.ack;
    throw new HelloRejectedError(
      ack.code,
      isTerminalHelloCode(ack.code)
        ? `edge rejected this device (${ack.code}): ${ack.message}`
        : `edge is not ready for this device (${ack.code}): ${ack.message}`,
      !isTerminalHelloCode(ack.code),
    );
  }

  let limits: HelloLimits;
  try {
    limits = validateHelloAckLimits(handshake.ack);
  } catch (error) {
    handshake.detach();
    socket.terminate();
    throw error;
  }

  let resolveClosed: ((info: TunnelCloseInfo) => void) | undefined;
  const closed = new Promise<TunnelCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });

  const attached: AttachedSocket = attachMux(socket, {
    role: 'agent',
    heartbeatMs: limits.heartbeatMs,
    idleTimeoutMs: limits.idleTimeoutMs,
    initialStreamWindow: limits.initialStreamWindow,
    onStream: options.onStream,
    onClose: (code, reason) => {
      const info = { code, reason, at: Date.now() };
      options.logger?.debug('tunnel transport closed', { code, reason });
      resolveClosed?.(info);
    },
    onError: (error) => {
      options.logger?.warn('tunnel mux error', { error });
    },
  });

  // Replace the raw handshake listener with the mux, then replay frames that
  // arrived in the tiny window after HELLO_ACK was decoded.
  handshake.detach();
  for (const chunk of handshake.buffered) attached.mux.handleMessage(chunk);

  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    const code = lastClose?.code ?? 1006;
    const reason = lastClose?.reason ?? 'edge closed the tunnel immediately after HELLO_ACK';
    attached.mux.handleTransportClose(code, reason);
  }

  return {
    mux: attached.mux,
    socket,
    closed,
    close(code = 1000, reason = 'agent stopping') {
      attached.mux.close(code, reason);
    },
    terminate() {
      socket.terminate();
      attached.detach();
    },
  };
}

export interface TunnelCloseClassification {
  retryable: boolean;
  message: string;
}

export function classifyTunnelClose(info: TunnelCloseInfo): TunnelCloseClassification {
  return {
    retryable: !isTerminalCloseCode(info.code),
    message: describeCloseCode(info.code, info.reason),
  };
}