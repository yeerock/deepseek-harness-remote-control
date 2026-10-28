/**
 * Transport adapter: `ws` WebSocket ⇄ MuxTransport, plus the message wiring.
 *
 * Kept in one place so the edge and the agent cannot disagree about binary
 * frames, close handling, or error ordering.
 */
import type { RawData, WebSocket } from 'ws';
import { Mux, type MuxTransport } from '@dsh-rc/mux';

function toBytes(data: RawData): Uint8Array {
  // Copy: DATA payloads are queued and consumed after the socket callback
  // returns, so a view into a pooled Buffer is not safe to retain.
  if (Buffer.isBuffer(data)) return Uint8Array.from(data);
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
  return Uint8Array.from(new Uint8Array(data));
}

export function webSocketTransport(socket: WebSocket): MuxTransport {
  return {
    send(data) {
      socket.send(data, { binary: true });
    },
    close(code, reason) {
      try {
        socket.close(code, reason.slice(0, 120));
      } catch {
        /* already closing */
      }
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
  };
}

export interface AttachedSocket {
  mux: Mux;
  detach(): void;
}

/**
 * Build a mux over a live socket and route every message/close into it.
 * The caller owns construction options (role, handlers); this function only
 * enforces the transport contract: binary frames, no text.
 */
export function attachMux(socket: WebSocket, options: {
  role: 'edge' | 'agent';
  heartbeatMs?: number;
  idleTimeoutMs?: number;
  initialStreamWindow?: number;
  onStream?: ConstructorParameters<typeof Mux>[0]['onStream'];
  onClose?: ConstructorParameters<typeof Mux>[0]['onClose'];
  onError?: ConstructorParameters<typeof Mux>[0]['onError'];
}): AttachedSocket {
  const mux = new Mux({
    transport: webSocketTransport(socket),
    role: options.role,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.initialStreamWindow === undefined ? {} : { initialStreamWindow: options.initialStreamWindow }),
    ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (!isBinary) {
      mux.close(1003, 'text frames are not part of the tunnel protocol');
      return;
    }
    mux.handleMessage(toBytes(data));
  };
  const onClose = (code: number, reason: Buffer): void => {
    mux.handleTransportClose(code, reason.toString('utf8'));
  };
  const onError = (error: Error): void => {
    options.onError?.(error);
  };

  socket.on('message', onMessage);
  socket.on('close', onClose);
  socket.on('error', onError);
  mux.start();

  return {
    mux,
    detach() {
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    },
  };
}