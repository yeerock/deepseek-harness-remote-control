/**
 * Device-scoped sharing API client.
 *
 * The host plugin talks to the edge with the device secret from
 * `<stateDir>/device.json` (mode 0600). The secret is read on demand, sent only
 * as an `Authorization: Bearer` header, and never logged, echoed to the
 * browser, or included in an error message.
 *
 * Normative contract: `docs/SHARING.md` §5.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SupervisorLogger } from './agent-supervisor.js';

export interface SharingInvite {
  id: string;
  label?: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

export interface PendingApproval {
  id: string;
  label?: string;
  ip: string;
  createdAt: number;
}

export interface ActiveGuest {
  sessionId: string;
  label?: string;
  ip: string;
  since: number;
  /** Always null for guests: sessions do not expire on their own. */
  expiresAt: number | null;
}

export interface SharingState {
  enabled: boolean;
  publicUrl: string;
  invites: SharingInvite[];
  pendingApprovals: PendingApproval[];
  activeGuests: ActiveGuest[];
}

export interface HarnessPeer {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt?: number | null;
}

export interface PeerList {
  peers: HarnessPeer[];
  publicUrl: string;
}

export interface CreatedInvite {
  id: string;
  /** Full guest URL (`<publicUrl>/i/<token>`). Shown once; never logged. */
  url: string;
  token: string;
  expiresAt: number;
}

export type SharingErrorCode =
  | 'IDENTITY_MISSING'
  | 'IDENTITY_INVALID'
  | 'IDENTITY_INSECURE'
  | 'INVALID_ARGUMENT'
  | 'HTTP_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE';

/** Typed sharing failure. Messages are safe to show in the panel. */
export class SharingError extends Error {
  readonly code: SharingErrorCode;
  /** Machine code the edge returned (e.g. `RATE_LIMITED`), when any. */
  readonly remoteCode?: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: SharingErrorCode,
    message: string,
    extra: { status?: number; retryAfterSeconds?: number; remoteCode?: string } = {},
  ) {
    super(message);
    this.name = 'SharingError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterSeconds !== undefined) this.retryAfterSeconds = extra.retryAfterSeconds;
    if (extra.remoteCode !== undefined) this.remoteCode = extra.remoteCode;
  }
}

export interface SharingClientOptions {
  stateDir: string;
  /** Plugin config `edgeUrl`; trailing slashes are ignored. */
  edgeUrl: string;
  logger?: Pick<SupervisorLogger, 'debug' | 'warn'>;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface DeviceIdentityFile {
  deviceId: string;
  deviceSecret: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LABEL_LENGTH = 64;
const MAX_TTL_SECONDS = 86_400;
const MAX_USES_LIMIT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Read and validate `<stateDir>/device.json`. The file is written by the agent
 * with mode 0600; a loosely-permissioned file is refused rather than used.
 */
export function readDeviceIdentity(stateDir: string): DeviceIdentityFile {
  const file = join(stateDir, 'device.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new SharingError(
      'IDENTITY_MISSING',
      'Device identity not found. Start the Remote Control agent once so this desktop registers with the edge.',
    );
  }
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new SharingError(
          'IDENTITY_INSECURE',
          `Device identity file has mode ${mode.toString(8)}; expected 0600. Fix permissions before sharing.`,
        );
      }
    } catch (error) {
      if (error instanceof SharingError) throw error;
      throw new SharingError('IDENTITY_INVALID', 'Device identity file could not be inspected.');
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SharingError('IDENTITY_INVALID', 'Device identity file is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new SharingError('IDENTITY_INVALID', 'Device identity file has the wrong shape.');
  const deviceId = parsed['deviceId'];
  const deviceSecret = parsed['deviceSecret'];
  if (typeof deviceId !== 'string' || deviceId === '' || typeof deviceSecret !== 'string' || deviceSecret === '') {
    throw new SharingError('IDENTITY_INVALID', 'Device identity file is missing deviceId or deviceSecret.');
  }
  return { deviceId, deviceSecret };
}

function normalizeSharing(value: unknown): SharingState {
  if (!isRecord(value)) throw new SharingError('BAD_RESPONSE', 'The edge returned an invalid sharing payload.');
  const invites: SharingInvite[] = [];
  for (const item of Array.isArray(value['invites']) ? value['invites'] : []) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue;
    invites.push({
      id: item['id'],
      ...(typeof item['label'] === 'string' && item['label'] !== '' ? { label: item['label'] } : {}),
      expiresAt: numberOr(item['expiresAt'], 0),
      maxUses: numberOr(item['maxUses'], 1),
      uses: numberOr(item['uses'], 0),
    });
  }
  const pendingApprovals: PendingApproval[] = [];
  for (const item of Array.isArray(value['pendingApprovals']) ? value['pendingApprovals'] : []) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue;
    pendingApprovals.push({
      id: item['id'],
      ...(typeof item['label'] === 'string' && item['label'] !== '' ? { label: item['label'] } : {}),
      ip: stringOr(item['ip'], ''),
      createdAt: numberOr(item['createdAt'], 0),
    });
  }
  const activeGuests: ActiveGuest[] = [];
  for (const item of Array.isArray(value['activeGuests']) ? value['activeGuests'] : []) {
    if (!isRecord(item) || typeof item['sessionId'] !== 'string') continue;
    activeGuests.push({
      sessionId: item['sessionId'],
      ...(typeof item['label'] === 'string' && item['label'] !== '' ? { label: item['label'] } : {}),
      ip: stringOr(item['ip'], ''),
      since: numberOr(item['since'], 0),
      expiresAt: item['expiresAt'] === null ? null : numberOr(item['expiresAt'], 0),
    });
  }
  return {
    enabled: value['enabled'] === true,
    publicUrl: stringOr(value['publicUrl'], ''),
    invites,
    pendingApprovals,
    activeGuests,
  };
}

/** Device-authenticated edge API for one state directory. */
export class SharingClient {
  private readonly stateDir: string;
  private readonly baseUrl: string;
  private readonly logger: Pick<SupervisorLogger, 'debug' | 'warn'> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SharingClientOptions) {
    this.stateDir = options.stateDir;
    this.baseUrl = options.edgeUrl.replace(/\/+$/, '');
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `GET /v1/devices/me/sharing`. */
  async getSharing(): Promise<SharingState> {
    const body = await this.request('GET', '/v1/devices/me/sharing');
    return normalizeSharing(body);
  }

  /** One-time iframe embed URL for an approved peer Harness. */
  async embedTicket(deviceId: string): Promise<string> {
    const body = await this.request('POST', '/v1/devices/me/embed-ticket', { deviceId });
    return isRecord(body) && typeof body['url'] === 'string' ? body['url'] : '';
  }

  /** `GET /v1/devices/me/peers` — approved Harnesses, metadata only. */
  async listPeers(): Promise<PeerList> {
    const body = await this.request('GET', '/v1/devices/me/peers');
    const record = isRecord(body) ? body : {};
    const rawPeers = Array.isArray(record['peers']) ? record['peers'] : [];
    const peers: HarnessPeer[] = [];
    for (const raw of rawPeers) {
      if (!isRecord(raw) || typeof raw['id'] !== 'string' || raw['id'] === '') continue;
      peers.push({
        id: raw['id'],
        name: typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : raw['id'],
        platform: typeof raw['platform'] === 'string' ? raw['platform'] : 'unknown',
        online: raw['online'] === true,
        lastSeenAt: typeof raw['lastSeenAt'] === 'number' ? raw['lastSeenAt'] : null,
      });
    }
    return {
      peers,
      publicUrl: typeof record['publicUrl'] === 'string' ? record['publicUrl'] : '',
    };
  }

  /** `PUT /v1/devices/me/sharing` — disabling revokes invites and guest sessions. */
  async setSharing(enabled: boolean): Promise<{ enabled: boolean }> {
    if (typeof enabled !== 'boolean') throw new SharingError('INVALID_ARGUMENT', 'enabled must be a boolean.');
    const body = await this.request('PUT', '/v1/devices/me/sharing', { enabled });
    return { enabled: isRecord(body) && body['enabled'] === true };
  }

  /** `POST /v1/devices/me/invites` — single use, `ttlSeconds: 0` means never. */
  async createInvite(input: { label?: string; ttlSeconds?: number; maxUses?: number }): Promise<CreatedInvite> {
    const body: Record<string, unknown> = {};
    const label = input.label?.trim();
    if (label !== undefined && label !== '') {
      if (label.length > MAX_LABEL_LENGTH) throw new SharingError('INVALID_ARGUMENT', `label must be at most ${String(MAX_LABEL_LENGTH)} characters.`);
      body['label'] = label;
    }
    const ttlSeconds = input.ttlSeconds ?? 900;
    if (ttlSeconds !== 0 && (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS)) {
      throw new SharingError('INVALID_ARGUMENT', 'ttlSeconds must be 0 (never) or 60..86400.');
    }
    body['ttlSeconds'] = ttlSeconds;
    const maxUses = input.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_LIMIT) {
      throw new SharingError('INVALID_ARGUMENT', `maxUses must be 1..${String(MAX_USES_LIMIT)}.`);
    }
    body['maxUses'] = maxUses;

    const response = await this.request('POST', '/v1/devices/me/invites', body);
    if (!isRecord(response) || typeof response['url'] !== 'string' || typeof response['id'] !== 'string') {
      throw new SharingError('BAD_RESPONSE', 'The edge did not return an invite URL.');
    }
    return {
      id: response['id'],
      url: response['url'],
      token: stringOr(response['token'], ''),
      expiresAt: numberOr(response['expiresAt'], 0),
    };
  }

  /** `DELETE /v1/devices/me/invites/:id`. */
  async revokeInvite(id: string): Promise<void> {
    await this.request('DELETE', `/v1/devices/me/invites/${encodeURIComponent(requireId(id))}`);
  }

  /** `POST /v1/devices/me/approvals/:id`. */
  async decideApproval(id: string, decision: 'approve' | 'deny', ttlSeconds?: number): Promise<void> {
    if (decision !== 'approve' && decision !== 'deny') {
      throw new SharingError('INVALID_ARGUMENT', 'decision must be approve or deny.');
    }
    const body: Record<string, unknown> = { decision };
    if (ttlSeconds !== undefined) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > MAX_TTL_SECONDS) {
        throw new SharingError('INVALID_ARGUMENT', 'ttlSeconds must be 0..86400.');
      }
      body['ttlSeconds'] = ttlSeconds;
    }
    await this.request('POST', `/v1/devices/me/approvals/${encodeURIComponent(requireId(id))}`, body);
  }

  /** `DELETE /v1/devices/me/guests/:sessionId`. */
  async revokeGuest(sessionId: string): Promise<void> {
    await this.request('DELETE', `/v1/devices/me/guests/${encodeURIComponent(requireId(sessionId))}`);
  }

  /** `DELETE /v1/devices/me/guests` — revokes every guest session. */
  async revokeAllGuests(): Promise<{ revoked: number }> {
    const body = await this.request('DELETE', '/v1/devices/me/guests');
    return { revoked: isRecord(body) ? numberOr(body['revoked'], 0) : 0 };
  }

  /* ------------------------------ transport ------------------------------ */

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const identity = readDeviceIdentity(this.stateDir);
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${identity.deviceSecret}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    this.logger?.debug('edge request', { method, path });
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // Deliberately no URL, headers, or identity in the message: the secret
      // must not reach a log or the browser through an error.
      throw new SharingError(
        'TRANSPORT_ERROR',
        error instanceof Error && error.name === 'AbortError'
          ? `The edge did not answer within ${String(this.timeoutMs / 1000)}s.`
          : 'Could not reach the edge. Check edgeUrl and the network path.',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown;
    let parseFailed = false;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parseFailed = true;
      }
    }

    if (!response.ok) {
      const errorBody = isRecord(parsed) ? parsed : {};
      const nested = isRecord(errorBody['error']) ? errorBody['error'] : {};
      const code = typeof nested['code'] === 'string' && nested['code'] !== ''
        ? nested['code']
        : typeof errorBody['code'] === 'string' && errorBody['code'] !== ''
          ? errorBody['code']
          : `HTTP_${String(response.status)}`;
      const rawMessage = typeof nested['message'] === 'string' && nested['message'] !== ''
        ? nested['message']
        : `The edge rejected the request (HTTP ${String(response.status)}).`;
      // A buggy or hostile edge must not be able to reflect the device secret
      // back into the panel or a log line through an error message.
      const message = rawMessage.split(identity.deviceSecret).join('[redacted]');
      const retryAfter = Number(response.headers.get('retry-after') ?? '');
      throw new SharingError('HTTP_ERROR', message, {
        status: response.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
        remoteCode: code,
      });
    }

    if (text === '') return {};
    if (parseFailed) throw new SharingError('BAD_RESPONSE', 'The edge returned a non-JSON response.');
    return parsed;
  }
}

/** Best-effort machine code for the RPC envelope (edge code first). */
export function sharingErrorCode(error: unknown): string {
  if (error instanceof SharingError) return error.remoteCode ?? error.code;
  return 'internal';
}

function requireId(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 200) throw new SharingError('INVALID_ARGUMENT', 'A valid id is required.');
  return trimmed;
}