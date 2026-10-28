/**
 * Minimal edge stand-in for agent tests.
 *
 * Implements the device API from task-2 (register → secret + pair URL, `/me`
 * approval state) and a real tunnel endpoint: raw HELLO/HELLO_ACK handshake,
 * then `attachMux(role: "edge")`. Tests use it to open HTTP/WS streams toward
 * the agent exactly as the real edge would.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { attachMux, newDeviceId, randomToken } from '@dsh-rc/shared';
import type { Mux, Stream } from '@dsh-rc/mux';
import {
  FrameType,
  INITIAL_CONNECTION_WINDOW,
  INITIAL_STREAM_WINDOW,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  isHello,
  type HelloAck,
  type Open,
} from '@dsh-rc/protocol';

export interface MockDevice {
  deviceId: string;
  secret: string;
  name: string;
  status: 'pending' | 'approved' | 'revoked';
  pairUrl: string;
}

export interface EdgeTunnel {
  deviceId: string;
  mux: Mux;
  socket: WebSocket;
}

export interface MockEdgeOptions {
  /** Approve devices at registration time (most tests). Defaults to true. */
  autoApprove?: boolean;
  /** Replace the computed pair URL (used for injection tests). */
  pairUrlOverride?: string;
  /** Make the next HELLO fail with this code instead of accepting. */
  helloFailure?: { code: string; message: string } | undefined;
}

interface Waiter {
  count: number;
  resolve: (tunnel: EdgeTunnel) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MockEdge {
  readonly devices = new Map<string, MockDevice>();
  readonly pairs = new Map<string, MockDevice>();
  registerCount = 0;
  mePollCount = 0;
  tunnelConnectCount = 0;
  helloRejections = 0;
  currentTunnel: EdgeTunnel | undefined;
  helloFailure: MockEdgeOptions['helloFailure'];

  private autoApprove: boolean;
  private pairUrlOverride: string | undefined;
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly waiters: Waiter[] = [];
  private readonly tunnels: EdgeTunnel[] = [];

  constructor(options: MockEdgeOptions = {}) {
    this.autoApprove = options.autoApprove ?? true;
    this.pairUrlOverride = options.pairUrlOverride;
    this.helloFailure = options.helloFailure;
  }

  get port(): number {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') throw new Error('mock edge not listening');
    return (address as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  get device(): MockDevice | undefined {
    return [...this.devices.values()][0];
  }

  approve(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device === undefined) throw new Error(`unknown device ${deviceId}`);
    device.status = 'approved';
  }

  revoke(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device === undefined) throw new Error(`unknown device ${deviceId}`);
    device.status = 'revoked';
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path !== '/v1/tunnel') {
        socket.destroy();
        return;
      }
      const header = request.headers.authorization ?? '';
      const secret = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
      const device = secret === undefined ? undefined : [...this.devices.values()].find((entry) => entry.secret === secret);
      if (device === undefined) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        this.attachTunnel(ws, device);
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
  }

  /** Resolve once at least `count` tunnel connections have been accepted. */
  waitForTunnelCount(count = 1, timeoutMs = 8_000): Promise<EdgeTunnel> {
    if (this.currentTunnel !== undefined && this.tunnelConnectCount >= count) {
      return Promise.resolve(this.currentTunnel);
    }
    return new Promise<EdgeTunnel>((resolve, reject) => {
      const waiter: Waiter = {
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`mock edge saw ${String(this.tunnelConnectCount)} tunnel(s); wanted ${String(count)}`));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  waitForTunnel(timeoutMs = 8_000): Promise<EdgeTunnel> {
    return this.waitForTunnelCount(1, timeoutMs);
  }

  openHttp(open: Open): Stream {
    const tunnel = this.currentTunnel;
    if (tunnel === undefined) throw new Error('no tunnel connected');
    const stream = tunnel.mux.open(open);
    // The real edge always terminates a request body, even an empty one.
    if (open.method === 'GET' || open.method === 'HEAD') void stream.end();
    return stream;
  }

  openWs(open: Open): Stream {
    return this.openHttp(open);
  }

  dropTunnel(): void {
    this.currentTunnel?.socket.terminate();
  }

  closeTunnel(code: number, reason: string): void {
    this.currentTunnel?.socket.close(code, reason);
  }

  private setTunnel(tunnel: EdgeTunnel): void {
    this.tunnels.push(tunnel);
    this.currentTunnel = tunnel;
    for (const waiter of [...this.waiters]) {
      if (this.tunnelConnectCount < waiter.count) continue;
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(tunnel);
    }
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', this.url);
    if (request.method === 'POST' && url.pathname === '/v1/devices/register') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const device: MockDevice = {
          deviceId: newDeviceId(),
          secret: randomToken(32),
          name: typeof body['name'] === 'string' ? body['name'] : 'test-device',
          status: this.autoApprove ? 'approved' : 'pending',
          pairUrl: '',
        };
        device.pairUrl = this.pairUrlOverride ?? `${this.url}/pair?code=pc-${device.deviceId.slice(-8)}`;
        this.devices.set(device.deviceId, device);
        this.pairs.set(device.pairUrl, device);
        this.registerCount += 1;
        this.respondJson(response, 201, {
          deviceId: device.deviceId,
          deviceSecret: device.secret,
          pairUrl: device.pairUrl,
          status: device.status,
        });
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/devices/me') {
      this.mePollCount += 1;
      const header = request.headers.authorization ?? '';
      const secret = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
      const device = secret === undefined ? undefined : [...this.devices.values()].find((entry) => entry.secret === secret);
      if (device === undefined) {
        this.respondJson(response, 401, { code: 'AUTH_FAILED', message: 'unknown device' });
        return;
      }
      if (device.status === 'revoked') {
        this.respondJson(response, 403, { code: 'DEVICE_REVOKED', message: 'device revoked' });
        return;
      }
      this.respondJson(response, 200, {
        deviceId: device.deviceId,
        status: device.status,
        pairUrl: device.pairUrl,
      });
      return;
    }

    this.respondJson(response, 404, { code: 'NOT_FOUND', message: 'not found' });
  }

  private respondJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': String(payload.byteLength),
    });
    response.end(payload);
  }

  private attachTunnel(socket: WebSocket, device: MockDevice): void {
    this.tunnelConnectCount += 1;
    socket.on('error', () => undefined);
    const previous = this.currentTunnel;
    if (previous !== undefined) previous.socket.close(4004, 'tunnel replaced');

    const buffered: Uint8Array[] = [];
    let acknowledged = false;
    let finished = false;

    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };

    const reject = (code: string, message: string, closeCode: number): void => {
      if (finished) return;
      finished = true;
      this.helloRejections += 1;
      const ack: HelloAck = { ok: false, code, message };
      try {
        socket.send(encodeFrame(FrameType.HelloAck, 0, encodeJson(ack)), { binary: true });
        socket.close(closeCode, message.slice(0, 120));
      } catch {
        socket.terminate();
      }
      cleanup();
    };

    const onClose = (): void => {
      cleanup();
    };

    const onMessage = (data: unknown, isBinary: boolean): void => {
      const bytes = bufferFrom(data);
      if (acknowledged) {
        buffered.push(bytes);
        return;
      }
      if (!isBinary) {
        reject('PROTOCOL_TEXT_FRAME', 'text frames are not allowed', 4001);
        return;
      }
      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch {
        reject('PROTOCOL_BAD_FRAME', 'malformed HELLO frame', 4001);
        return;
      }
      if (frame.type !== FrameType.Hello) {
        reject('PROTOCOL_BAD_FRAME', 'expected HELLO', 4001);
        return;
      }
      let hello;
      try {
        hello = decodeJson(frame.payload, isHello);
      } catch {
        reject('PROTOCOL_BAD_FRAME', 'invalid HELLO', 4001);
        return;
      }
      if (hello.deviceId !== device.deviceId || hello.token !== device.secret) {
        reject('AUTH_FAILED', 'device id or secret mismatch', 4002);
        return;
      }
      if (this.helloFailure !== undefined) {
        reject(this.helloFailure.code, this.helloFailure.message, 4003);
        return;
      }
      if (device.status === 'revoked') {
        reject('DEVICE_REVOKED', 'device revoked', 4003);
        return;
      }
      if (device.status !== 'approved') {
        reject('DEVICE_PENDING', 'device is waiting for approval', 4004);
        return;
      }

      const ack: HelloAck = {
        ok: true,
        protocol: PROTOCOL_VERSION,
        edgeId: 'edge_test',
        serverTime: Date.now(),
        heartbeatMs: 15_000,
        idleTimeoutMs: 45_000,
        initialStreamWindow: INITIAL_STREAM_WINDOW,
        initialConnectionWindow: INITIAL_CONNECTION_WINDOW,
        maxFrameBytes: MAX_FRAME_BYTES,
      };
      acknowledged = true;
      socket.send(encodeFrame(FrameType.HelloAck, 0, encodeJson(ack)), { binary: true });
      const attached = attachMux(socket, {
        role: 'edge',
        onClose: () => {
          cleanup();
          if (this.currentTunnel?.socket === socket) this.currentTunnel = undefined;
        },
        onError: () => undefined,
      });
      cleanup();
      for (const chunk of buffered) attached.mux.handleMessage(chunk);
      this.setTunnel({ deviceId: device.deviceId, mux: attached.mux, socket });
    };

    socket.on('message', onMessage);
    socket.on('close', onClose);
  }

  async stop(): Promise<void> {
    for (const tunnel of this.tunnels) tunnel.socket.terminate();
    for (const waiter of this.waiters.splice(0, this.waiters.length)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('mock edge stopped'));
    }
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

function bufferFrom(data: unknown): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data as Uint8Array);
}

/** A tiny promise-based deadline used by the tests. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function startHeaderOpen(path: string, extraHeaders: Array<[string, string]> = [], kind: 'http' | 'ws' = 'http'): Open {
  return {
    kind,
    method: 'GET',
    path,
    headers: [['accept', '*/*'], ...extraHeaders],
    priority: 'high',
  };
}