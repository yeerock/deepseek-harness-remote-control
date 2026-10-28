/**
 * Minimal HTTPS/HTTP JSON client for the edge device API.
 *
 * Node built-ins only (no fetch) so `--insecure` can disable certificate
 * verification for self-signed deployments without touching process globals.
 * Device secrets travel only in the Authorization header and never appear in
 * error messages or logs.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Logger } from '@dsh-rc/shared';
import { isValidDeviceId } from '@dsh-rc/protocol';
import { EdgeHttpError, TerminalAgentError, messageOf } from './errors.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface EdgeEndpoint {
  /** HTTP(S) origin, no trailing slash: `https://edge.example.com`. */
  apiBase: string;
  /** ws(s) tunnel URL derived from the same origin. */
  tunnelUrl: string;
}

function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

const MAX_PAIR_URL_LENGTH = 2048;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/**
 * Accept a pair URL from the edge only if it is a single-line http(s) URL on
 * the edge's own origin. A compromised edge must not be able to inject newlines
 * into the CLI's `DSHRC_PAIR_URL=` line or publish a foreign/javascript URL.
 * Returns undefined (and logs a value-free warning) on rejection.
 */
export function sanitizePairUrl(pairUrl: unknown, edgeApiBase: string, logger?: Logger): string | undefined {
  if (typeof pairUrl !== 'string' || pairUrl === '' || pairUrl.length > MAX_PAIR_URL_LENGTH) {
    if (pairUrl !== undefined) logger?.warn('ignored an invalid pair URL from the edge');
    return undefined;
  }
  if (CONTROL_CHAR_RE.test(pairUrl)) {
    logger?.warn('ignored a pair URL containing control characters');
    return undefined;
  }
  let parsed: URL;
  let edgeOrigin: string;
  try {
    parsed = new URL(pairUrl);
    edgeOrigin = new URL(edgeApiBase).origin;
  } catch {
    logger?.warn('ignored an unparseable pair URL from the edge');
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logger?.warn('ignored a non-http(s) pair URL from the edge');
    return undefined;
  }
  if (parsed.origin !== edgeOrigin) {
    logger?.warn('ignored a cross-origin pair URL from the edge');
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    logger?.warn('ignored a pair URL with embedded credentials');
    return undefined;
  }
  return pairUrl;
}

/**
 * Normalise an edge URL and enforce the transport policy: plain HTTP/WS is
 * allowed only for loopback (laptop demo) or when `insecure` was requested.
 */
export function normalizeEdgeUrl(edgeUrl: string, insecure: boolean): EdgeEndpoint {
  let url: URL;
  try {
    url = new URL(edgeUrl);
  } catch {
    throw new TerminalAgentError('AGENT_CONFIG', `invalid edgeUrl: ${edgeUrl}`);
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TerminalAgentError('AGENT_CONFIG', `unsupported edgeUrl protocol: ${url.protocol}`);
  }
  if (url.protocol === 'http:' && !insecure && !isLoopbackHostname(url.hostname)) {
    throw new TerminalAgentError(
      'AGENT_CONFIG',
      'refusing plain http:// to a non-loopback edge; use https:// or pass insecure:true',
    );
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  const apiBase = `${url.protocol}//${url.host}${basePath}`;
  const tunnelUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${basePath}/v1/tunnel`;
  return { apiBase, tunnelUrl };
}

interface JsonResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  insecure: boolean;
}

function requestJson(url: URL, options: RequestOptions): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8');
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.byteLength);
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: !options.insecure } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('edge response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = undefined;
          if (text !== '') {
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
        response.on('error', reject);
      },
    );
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('edge request timed out'));
    });
    request.on('error', (error) => {
      reject(error);
    });
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function bodyMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'reason']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function bodyCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const value = record['code'];
  return typeof value === 'string' ? value : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export interface RegisteredDevice {
  deviceId: string;
  deviceSecret: string;
  pairUrl?: string;
  status?: string;
}

export interface DeviceState {
  deviceId?: string;
  status?: string;
  pairUrl?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

export class EdgeClient {
  readonly endpoint: EdgeEndpoint;
  private readonly insecure: boolean;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number;

  constructor(options: { edgeUrl: string; insecure?: boolean; logger?: Logger; timeoutMs?: number }) {
    this.insecure = options.insecure === true;
    this.endpoint = normalizeEdgeUrl(options.edgeUrl, this.insecure);
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call(pathname: string, options: { method: 'GET' | 'POST'; secret?: string; body?: unknown }): Promise<JsonResponse> {
    const headers: Record<string, string> = { 'user-agent': 'dsh-rc-agent/0.1.0' };
    if (options.secret !== undefined) headers['authorization'] = `Bearer ${options.secret}`;
    try {
      return await requestJson(new URL(`${this.endpoint.apiBase}${pathname}`), {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        timeoutMs: this.timeoutMs,
        insecure: this.insecure,
      });
    } catch (error) {
      throw new EdgeHttpError(0, `edge request failed: ${messageOf(error)}`, true);
    }
  }

  /** POST /v1/devices/register — the response carries the one-time device secret. */
  async registerDevice(input: { name: string; platform: string; agentVersion: string }): Promise<RegisteredDevice> {
    const response = await this.call('/v1/devices/register', { method: 'POST', body: input });
    if (response.status < 200 || response.status >= 300) {
      throw new EdgeHttpError(
        response.status,
        `device registration failed (HTTP ${String(response.status)}): ${bodyMessage(response.body) ?? 'edge refused the request'}`,
        isRetryableStatus(response.status),
      );
    }
    const top = record(response.body);
    if (top === undefined) throw new EdgeHttpError(response.status, 'device registration returned no JSON body', true);
    const device = record(top['device']) ?? top;
    const deviceId = device['deviceId'];
    const deviceSecret = device['deviceSecret'];
    if (typeof deviceId !== 'string' || !isValidDeviceId(deviceId)) {
      throw new EdgeHttpError(response.status, 'device registration response has an invalid deviceId', true);
    }
    if (typeof deviceSecret !== 'string' || deviceSecret.length === 0 || deviceSecret.length > 512) {
      throw new EdgeHttpError(response.status, 'device registration response has an invalid deviceSecret', true);
    }
    const pairUrl = sanitizePairUrl(device['pairUrl'], this.endpoint.apiBase, this.logger);
    const status = typeof device['status'] === 'string' ? device['status'] : undefined;
    return {
      deviceId,
      deviceSecret,
      ...(pairUrl === undefined ? {} : { pairUrl }),
      ...(status === undefined ? {} : { status }),
    };
  }

  /** GET /v1/devices/me — pairing/approval state for a registered device. */
  async getDevice(secret: string): Promise<DeviceState> {
    const response = await this.call('/v1/devices/me', { method: 'GET', secret });
    if (response.status < 200 || response.status >= 300) {
      const code = bodyCode(response.body);
      const detail = bodyMessage(response.body) ?? `HTTP ${String(response.status)}`;
      const retryable = isRetryableStatus(response.status);
      if (code === 'DEVICE_REVOKED' || response.status === 403 || response.status === 401) {
        throw new EdgeHttpError(response.status, `device is no longer authorised: ${detail}`, false);
      }
      throw new EdgeHttpError(response.status, `device status request failed: ${detail}`, retryable);
    }
    const top = record(response.body);
    if (top === undefined) throw new EdgeHttpError(response.status, 'device status response is not JSON', true);
    const device = record(top['device']) ?? top;
    const deviceId = device['deviceId'];
    const status = device['status'];
    const pairUrl = sanitizePairUrl(device['pairUrl'], this.endpoint.apiBase, this.logger);
    this.logger?.debug('device status polled');
    return {
      ...(typeof deviceId === 'string' ? { deviceId } : {}),
      ...(typeof status === 'string' ? { status } : {}),
      ...(pairUrl === undefined ? {} : { pairUrl }),
    };
  }
}

/** True when the device status means "the owner approved this device". */
export function isApprovedStatus(status: string | undefined): boolean {
  return status === 'approved' || status === 'active' || status === 'online';
}

export function isRevokedStatus(status: string | undefined): boolean {
  return status === 'revoked' || status === 'rejected';
}