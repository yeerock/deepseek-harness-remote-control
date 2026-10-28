/**
 * Device lifecycle: registration, secret lookup, approval and revocation.
 *
 * A device registers once (no auth) and receives a 32-byte secret that is only
 * ever stored as SHA-256. Registration queues a single-use pair code; the
 * device stays `pending` until the owner approves it, either from the
 * dashboard/API or by redeeming the code on /pair.
 */
import {
  newDeviceId,
  newPairCode,
  normalizePairCode,
  pairCodeHash,
  randomToken,
  sha256Hex,
  tokenMatchesHash,
  type Logger,
} from '@dsh-rc/shared';
import type { EdgeConfig } from './config.js';
import type { DeviceRow, EdgeDatabase } from './db.js';

const NAME_MAX = 64;
const PLATFORM_MAX = 64;
const VERSION_MAX = 64;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface RegisterInput {
  name: string;
  platform: string;
  agentVersion: string;
}

export interface RegisteredDevice {
  device: DeviceRow;
  deviceSecret: string;
  pairCode: string;
}

export interface RequestMeta {
  ip: string | null;
  actor: string | null;
}

export function validateRegisterBody(body: unknown): { ok: true; value: RegisterInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (name.length === 0 || name.length > NAME_MAX) return { ok: false, error: `name must be 1-${String(NAME_MAX)} characters` };
  if (CONTROL_RE.test(name)) return { ok: false, error: 'name contains control characters' };
  const platform = typeof record['platform'] === 'string' ? record['platform'].trim() : 'unknown';
  if (platform.length > PLATFORM_MAX) return { ok: false, error: `platform must be at most ${String(PLATFORM_MAX)} characters` };
  if (CONTROL_RE.test(platform)) return { ok: false, error: 'platform contains control characters' };
  const agentVersion = typeof record['agentVersion'] === 'string' ? record['agentVersion'].trim() : '0.0.0';
  if (agentVersion.length > VERSION_MAX) return { ok: false, error: `agentVersion must be at most ${String(VERSION_MAX)} characters` };
  if (CONTROL_RE.test(agentVersion)) return { ok: false, error: 'agentVersion contains control characters' };
  return { ok: true, value: { name, platform: platform === '' ? 'unknown' : platform, agentVersion: agentVersion === '' ? '0.0.0' : agentVersion } };
}

export class DeviceService {
  constructor(
    private readonly config: EdgeConfig,
    private readonly db: EdgeDatabase,
    private readonly logger: Logger,
  ) {}

  register(input: RegisterInput, meta: RequestMeta): RegisteredDevice {
    const now = Date.now();
    const deviceId = newDeviceId();
    const deviceSecret = randomToken(32);
    const pairCode = newPairCode();
    const device = this.db.transaction(() => {
      const created = this.db.insertDevice({
        id: deviceId,
        name: input.name,
        platform: input.platform,
        agentVersion: input.agentVersion,
        secretHash: sha256Hex(deviceSecret),
        status: 'pending',
        createdAt: now,
      });
      this.db.insertPairCode(pairCodeHash(pairCode), deviceId, now, now + this.config.pairCodeTtlMs);
      this.db.addAudit({
        event: 'register',
        deviceId,
        actor: meta.actor,
        ip: meta.ip,
        detail: `${input.platform} · agent ${input.agentVersion}`,
        ts: now,
      });
      return created;
    });
    this.logger.info('device registered', { deviceId, platform: input.platform, agentVersion: input.agentVersion });
    return { device, deviceSecret, pairCode };
  }

  /**
   * Map a bearer secret back to its device. Every row is compared in
   * constant time and the loop does not short-circuit, so timing does not
   * reveal which device matched.
   */
  findBySecret(secret: string): DeviceRow | undefined {
    let match: DeviceRow | undefined;
    for (const device of this.db.listDevices()) {
      if (tokenMatchesHash(secret, device.secretHash)) match = device;
    }
    return match;
  }

  approve(deviceId: string, meta: RequestMeta): DeviceRow | undefined {
    const now = Date.now();
    const existing = this.db.getDevice(deviceId);
    if (existing === undefined) return undefined;
    if (existing.status === 'revoked') return existing;
    const device = this.db.approveDevice(deviceId, now);
    if (device !== undefined && existing.status !== 'approved') {
      this.db.addAudit({ event: 'approve', deviceId, actor: meta.actor, ip: meta.ip, ts: now });
      this.logger.info('device approved', { deviceId });
    }
    return device;
  }

  revoke(deviceId: string, meta: RequestMeta): DeviceRow | undefined {
    const now = Date.now();
    const existing = this.db.getDevice(deviceId);
    if (existing === undefined) return undefined;
    const device = this.db.revokeDevice(deviceId, now);
    this.db.deletePairCodesForDevice(deviceId);
    this.db.deleteSessionsForDevice(deviceId);
    if (existing.status !== 'revoked') {
      this.db.addAudit({ event: 'revoke', deviceId, actor: meta.actor, ip: meta.ip, ts: now });
      this.logger.warn('device revoked', { deviceId });
    }
    return device;
  }

  /** Redeem a pair code: approve the device and record the pairing. */
  redeemPairCode(code: string, meta: RequestMeta): { ok: true; device: DeviceRow } | { ok: false; reason: string } {
    const normalized = normalizePairCode(code);
    if (normalized === undefined) return { ok: false, reason: 'pair code has the wrong shape' };
    const now = Date.now();
    const deviceId = this.db.redeemPairCode(pairCodeHash(normalized), now);
    if (deviceId === undefined) return { ok: false, reason: 'pair code is unknown, used or expired' };
    const device = this.db.getDevice(deviceId);
    if (device === undefined) return { ok: false, reason: 'device no longer exists' };
    if (device.status === 'revoked') return { ok: false, reason: 'device has been revoked' };
    const approved = this.approve(deviceId, meta);
    if (approved === undefined) return { ok: false, reason: 'device no longer exists' };
    this.db.addAudit({ event: 'pair', deviceId, actor: meta.actor, ip: meta.ip, ts: now });
    this.logger.info('device paired', { deviceId });
    return { ok: true, device: approved };
  }

  publicDevice(device: DeviceRow, online: boolean): Record<string, unknown> {
    return {
      deviceId: device.id,
      name: device.name,
      platform: device.platform,
      agentVersion: device.agentVersion,
      status: device.status,
      online,
      createdAt: device.createdAt,
      approvedAt: device.approvedAt,
      revokedAt: device.revokedAt,
      lastSeenAt: device.lastSeenAt,
      lastConnectedAt: device.lastConnectedAt,
    };
  }
}