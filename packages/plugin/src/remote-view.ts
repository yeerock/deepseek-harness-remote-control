/**
 * Same-site loopback proxy for the in-app remote view.
 *
 * The DSH renderer lives on http://127.0.0.1:<dshPort>. An edge iframe is
 * cross-site and cannot boot the Harness plugin graph (third-party storage).
 * This server listens on another 127.0.0.1 port, injects a one-time edge
 * session cookie, and forwards HTTP + WebSocket to `/d/<device>/`. The iframe
 * is cross-origin but same-site, so storage and plugin boot work.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export interface RemoteViewOptions {
  edgeUrl: string;
  /** Mints a one-time edge embed URL for an approved device. */
  mintTicket: (deviceId: string) => Promise<string>;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

export class RemoteViewServer {
  private server: Server | undefined;
  private port = 0;
  private token = randomBytes(18).toString('base64url');
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly cookies = new Map<string, string>();
  private mountedOrigin = '';
  private mountedBase = '';

  constructor(private readonly options: RemoteViewOptions) {}

  async start(): Promise<string> {
    if (this.server !== undefined) return this.baseUrl();
    this.server = createServer((req, res) => void this.handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('remote view listen failed');
    this.port = address.port;
    this.options.logger?.info?.(`remote view proxy on 127.0.0.1:${String(this.port)}`);
    return this.baseUrl();
  }

  /** Mount on the DSH web server so the iframe is same-origin. */
  mount(webServer: { getOrigin?: () => string; register: (route: unknown) => unknown; registerUpgrade?: (route: unknown) => unknown }): void {
    this.mountedOrigin = webServer.getOrigin?.() ?? '';
    this.mountedBase = '/dsh-rc/remote';
    webServer.register({
      kind: 'prefix',
      path: this.mountedBase,
      handler: (req: IncomingMessage, res: ServerResponse) => this.handleMounted(req, res),
    });
    this.mountedUpgrade = (deviceId, path) => {
      if (typeof webServer.registerUpgrade !== 'function') return () => undefined;
      const dispose = webServer.registerUpgrade({
        path,
        handler: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => this.handleMountedUpgrade(req, socket, head),
      });
      return typeof dispose === 'function' ? dispose as () => void : () => undefined;
    };
  }

  private mountedUpgrade: ((deviceId: string, path: string) => () => void) | undefined;

  async embedUrl(deviceId: string): Promise<string> {
    if (this.mountedOrigin !== '') {
      await this.ensureCookie(deviceId);
      const path = `${this.mountedBase}/${encodeURIComponent(deviceId)}/api/remote.mux`;
      this.mountedUpgrade?.(deviceId, path);
      return `${this.mountedOrigin}${this.mountedBase}/${encodeURIComponent(deviceId)}/`;
    }
    await this.start();
    await this.ensureCookie(deviceId);
    return `${this.baseUrl()}/d/${encodeURIComponent(deviceId)}/`;
  }

  private async handleMounted(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rest = (req.url ?? '').slice(this.mountedBase.length);
    req.url = `/r/${this.token}/d${rest}`;
    await this.handleHttp(req, res);
  }

  private async handleMountedUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    const rest = (req.url ?? '').slice(this.mountedBase.length);
    req.url = `/r/${this.token}/d${rest}`;
    await this.handleUpgrade(req, socket, head);
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.wss.close();
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}/r/${this.token}`;
  }

  private async ensureCookie(deviceId: string): Promise<string> {
    const existing = this.cookies.get(deviceId);
    if (existing !== undefined) return existing;
    const ticket = await this.options.mintTicket(deviceId);
    const response = await fetch(ticket, { redirect: 'manual' });
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const value = line.split(';', 1)[0] ?? '';
      if (value.startsWith('dshrc_session=')) {
        this.cookies.set(deviceId, value);
        return value;
      }
    }
    throw new Error('edge embed ticket did not return a session cookie');
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const prefix = `/r/${this.token}`;
    if (!(req.url ?? '').startsWith(prefix)) {
      res.writeHead(404).end('not found');
      return;
    }
    const rest = (req.url ?? '').slice(prefix.length);
    const match = /^\/d\/([^/]+)(\/.*)?$/.exec(rest);
    if (match === null) {
      res.writeHead(404).end('not found');
      return;
    }
    const deviceId = decodeURIComponent(match[1] ?? '');
    try {
      const cookie = await this.ensureCookie(deviceId);
      const edge = new URL(this.options.edgeUrl);
      const target = `${edge.origin}${rest}`;
      const headers: Record<string, string | string[]> = { ...req.headers, cookie } as Record<string, string | string[]>;
      headers.host = edge.host;
      const client = edge.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = client(target, { method: req.method, headers }, (answer) => {
        if (answer.statusCode === 401) this.cookies.delete(deviceId);
        const headers = { ...answer.headers };
        delete headers['set-cookie'];
        res.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('edge unreachable'); });
      req.pipe(upstream);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'remote view failed');
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    const prefix = `/r/${this.token}`;
    if (!(req.url ?? '').startsWith(prefix)) { socket.destroy(); return; }
    const rest = (req.url ?? '').slice(prefix.length);
    const match = /^\/d\/([^/]+)(\/.*)?$/.exec(rest);
    if (match === null) { socket.destroy(); return; }
    const deviceId = decodeURIComponent(match[1] ?? '');
    try {
      const cookie = await this.ensureCookie(deviceId);
      const edge = new URL(this.options.edgeUrl);
      const wsUrl = `${edge.protocol === 'https:' ? 'wss:' : 'ws:'}//${edge.host}${rest}`;
      const upstream = new WebSocket(wsUrl, { headers: { cookie } });
      upstream.on('open', () => {
        this.wss.handleUpgrade(req, socket as import('node:net').Socket, head, (client) => {
          client.on('message', (data) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data); });
          upstream.on('message', (data) => { if (client.readyState === WebSocket.OPEN) client.send(data); });
          client.on('close', () => upstream.close());
          upstream.on('close', () => client.close());
        });
      });
      upstream.on('error', () => socket.destroy());
    } catch {
      socket.destroy();
    }
  }
}