/**
 * The tunnel side of the edge: one WebSocket per device, a HELLO/HELLO_ACK
 * handshake outside the mux, then `@dsh-rc/shared`'s attachMux for the
 * multiplexed streams.
 *
 * Presence is deliberate: after a disconnect the device stays "reconnecting"
 * for the presence grace window so a browser sees a retry page instead of a
 * hard failure while the agent's backoff is still working.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  FrameType,
  INITIAL_CONNECTION_WINDOW,
  INITIAL_STREAM_WINDOW,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  encodeJson,
  isHello,
  type HelloAck,
} from '@dsh-rc/protocol';
import { attachMux, clientAddress, requestHeader, tokenMatchesHash, type AttachedSocket, type Logger } from '@dsh-rc/shared';
import type { EdgeConfig } from './config.js';
import type { DeviceRow, EdgeDatabase } from './db.js';
import type { DeviceService } from './devices.js';
import { rejectUpgrade, toBytes } from './upgrade.js';

const HELLO_TIMEOUT_MS = 10_000;

export interface ActiveTunnel {
  deviceId: string;
  socket: WebSocket;
  attached: AttachedSocket;
  connectedAt: number;
  remoteAddress: string;
  platform: string;
}

export interface PresenceState {
  online: boolean;
  reconnecting: boolean;
  lastSeenAt: number | null;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = requestHeader(request, 'authorization');
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return undefined;
  const token = match[1]?.trim() ?? '';
  return token === '' ? undefined : token;
}

export class TunnelManager {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, ActiveTunnel>();
  private readonly closing = new Set<WebSocket>();

  constructor(
    private readonly config: EdgeConfig,
    private readonly db: EdgeDatabase,
    private readonly devices: DeviceService,
    private readonly logger: Logger,
    private readonly edgeId: string,
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      clientTracking: false,
    });
  }

  get size(): number {
    return this.connections.size;
  }

  /** Authenticate the upgrade and start the HELLO handshake. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = bearerToken(request);
    if (token === undefined) {
      rejectUpgrade(socket, 401, 'missing bearer device secret');
      return;
    }
    const device = this.devices.findBySecret(token);
    if (device === undefined) {
      this.logger.warn('tunnel upgrade rejected', { reason: 'unknown device secret', ip: clientAddress(request, this.config.trustProxy) });
      rejectUpgrade(socket, 401, 'unknown device secret');
      return;
    }
    const remoteAddress = clientAddress(request, this.config.trustProxy);
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.beginHandshake(ws, device, remoteAddress);
    });
  }

  get(deviceId: string): ActiveTunnel | undefined {
    const tunnel = this.connections.get(deviceId);
    if (tunnel === undefined) return undefined;
    if (tunnel.socket.readyState !== 1) return undefined;
    return tunnel;
  }

  isOnline(deviceId: string): boolean {
    return this.get(deviceId) !== undefined;
  }

  /** Presence including the post-disconnect grace window. */
  presence(device: DeviceRow, now = Date.now()): PresenceState {
    if (this.isOnline(device.id)) return { online: true, reconnecting: false, lastSeenAt: device.lastSeenAt };
    const lastSeenAt = device.lastSeenAt;
    const reconnecting = lastSeenAt !== null && now - lastSeenAt <= this.config.presenceGraceMs;
    return { online: false, reconnecting, lastSeenAt };
  }

  /** Close a device's live tunnel (revocation, shutdown). */
  closeDevice(deviceId: string, code: number, reason: string): boolean {
    const tunnel = this.connections.get(deviceId);
    if (tunnel === undefined) return false;
    tunnel.attached.mux.close(code, reason);
    return true;
  }

  closeAll(reason = 'edge shutting down'): void {
    for (const tunnel of [...this.connections.values()]) {
      try {
        tunnel.attached.mux.close(1001, reason);
      } catch {
        /* best effort */
      }
    }
    for (const ws of this.closing) {
      try {
        ws.terminate();
      } catch {
        /* best effort */
      }
    }
    this.closing.clear();
  }

  closeServer(): void {
    this.wss.close();
  }

  /* ------------------------------- handshake ------------------------------- */

  private beginHandshake(ws: WebSocket, device: DeviceRow, remoteAddress: string): void {
    let settled = false;
    this.closing.add(ws);

    const finish = (ack: HelloAck, closeCode: number, closeReason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      try {
        ws.send(encodeFrame(FrameType.HelloAck, 0, encodeJson(ack)), { binary: true });
      } catch {
        /* socket already gone */
      }
      try {
        ws.close(closeCode, closeReason.slice(0, 120));
      } catch {
        ws.terminate();
      }
      this.closing.delete(ws);
    };

    const timer = setTimeout(() => {
      // A slow network is not a bad secret: answer with a retryable code so the agent tries again.
      finish({ ok: false, code: 'HELLO_TIMEOUT', message: 'HELLO timeout' }, 4000, 'HELLO timeout');
    }, HELLO_TIMEOUT_MS);
    timer.unref?.();

    const onMessage = (raw: RawData, isBinary: boolean): void => {
      if (settled) return;
      if (!isBinary) {
        finish({ ok: false, code: 'PROTOCOL_TEXT_FRAME', message: 'text frames are not part of the tunnel protocol' }, 1003, 'text frame');
        return;
      }
      let frame;
      try {
        frame = decodeFrame(toBytes(raw));
      } catch (error) {
        finish(
          { ok: false, code: 'PROTOCOL_BAD_FRAME', message: error instanceof Error ? error.message : 'bad frame' },
          1002,
          'bad frame',
        );
        return;
      }
      if (frame.type !== FrameType.Hello || frame.streamId !== 0) {
        finish({ ok: false, code: 'PROTOCOL_BAD_FRAME', message: 'expected HELLO on stream 0' }, 1002, 'expected HELLO');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(frame.payload)) as unknown;
      } catch {
        finish({ ok: false, code: 'PROTOCOL_BAD_FRAME', message: 'HELLO is not valid JSON' }, 1002, 'bad HELLO JSON');
        return;
      }
      const protocol = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['protocol'] : undefined;
      if (protocol !== PROTOCOL_VERSION) {
        finish({ ok: false, code: 'PROTOCOL_MISMATCH', message: `unsupported protocol ${String(protocol)}` }, 4001, 'protocol mismatch');
        return;
      }
      if (!isHello(parsed)) {
        finish({ ok: false, code: 'PROTOCOL_BAD_FRAME', message: 'HELLO failed schema validation' }, 1002, 'bad HELLO');
        return;
      }
      if (parsed.deviceId !== device.id || !tokenMatchesHash(parsed.token, device.secretHash)) {
        finish({ ok: false, code: 'AUTH_FAILED', message: 'device id or secret does not match' }, 4002, 'AUTH_FAILED');
        return;
      }
      if (device.status === 'revoked') {
        finish({ ok: false, code: 'DEVICE_REVOKED', message: 'this device was revoked by the owner' }, 4003, 'DEVICE_REVOKED');
        return;
      }
      if (device.status === 'pending') {
        finish({ ok: false, code: 'DEVICE_PENDING', message: 'device is waiting for owner approval' }, 4002, 'DEVICE_PENDING');
        return;
      }

      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      try {
        ws.send(
          encodeFrame(
            FrameType.HelloAck,
            0,
            encodeJson({
              ok: true,
              protocol: PROTOCOL_VERSION,
              edgeId: this.edgeId,
              serverTime: Date.now(),
              heartbeatMs: DEFAULT_HEARTBEAT_MS,
              idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
              initialStreamWindow: INITIAL_STREAM_WINDOW,
              initialConnectionWindow: INITIAL_CONNECTION_WINDOW,
              maxFrameBytes: MAX_FRAME_BYTES,
            } satisfies HelloAck),
          ),
          { binary: true },
        );
      } catch {
        ws.terminate();
        return;
      }
      this.attach(ws, device, remoteAddress);
    };

    ws.on('message', onMessage);
    ws.on('error', (error) => {
      this.logger.warn('tunnel socket error during handshake', { deviceId: device.id, error });
    });
    ws.on('close', () => {
      clearTimeout(timer);
      this.closing.delete(ws);
    });
  }

  private attach(ws: WebSocket, device: DeviceRow, remoteAddress: string): void {
    const now = Date.now();
    const previous = this.connections.get(device.id);

    let tunnel!: ActiveTunnel;
    const attached = attachMux(ws, {
      role: 'edge',
      onClose: (code, reason) => {
        if (tunnel !== undefined) this.handleClose(tunnel, code, reason);
      },
      onError: (error) => {
        this.logger.warn('tunnel mux error', { deviceId: device.id, error });
      },
    });
    tunnel = {
      deviceId: device.id,
      socket: ws,
      attached,
      connectedAt: now,
      remoteAddress,
      platform: device.platform,
    };

    this.closing.delete(ws);
    this.connections.set(device.id, tunnel);
    this.db.markTunnelConnected(device.id, now);
    this.db.addAudit({
      event: 'tunnel-connect',
      deviceId: device.id,
      actor: 'agent',
      ip: remoteAddress,
      detail: previous === undefined ? device.platform : `${device.platform} · replaced older tunnel`,
      ts: now,
    });
    this.logger.info('tunnel connected', {
      deviceId: device.id,
      platform: device.platform,
      replaced: previous !== undefined,
      remoteAddress,
    });

    if (previous !== undefined) {
      try {
        previous.attached.mux.close(4004, 'TUNNEL_BUSY: replaced by a newer tunnel');
      } catch {
        try {
          previous.socket.terminate();
        } catch {
          /* already gone */
        }
      }
    }
  }

  private handleClose(tunnel: ActiveTunnel, code: number, reason: string): void {
    const current = this.connections.get(tunnel.deviceId);
    if (current === tunnel) this.connections.delete(tunnel.deviceId);
    const now = Date.now();
    this.db.markTunnelDisconnected(tunnel.deviceId, now);
    this.db.addAudit({
      event: 'tunnel-disconnect',
      deviceId: tunnel.deviceId,
      actor: 'agent',
      ip: tunnel.remoteAddress,
      detail: `code ${String(code)}${reason === '' ? '' : ` · ${reason.slice(0, 160)}`}`,
      ts: now,
    });
    this.logger.info('tunnel disconnected', { deviceId: tunnel.deviceId, code, reason: reason.slice(0, 160) });
  }
}