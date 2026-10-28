/**
 * Device identity persistence.
 *
 * `<stateDir>/device.json` holds the device id and the device secret (the
 * latter is hashed at rest on the edge, never logged, never sent anywhere but
 * the tunnel upgrade). Directory 0700, file 0600, written atomically so a
 * crash cannot truncate a working identity.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@dsh-link/shared';
import { isValidDeviceId } from '@dsh-link/protocol';

export const DEVICE_FILE_NAME = 'device.json';
export const IDENTITY_VERSION = 1;

export interface DeviceIdentity {
  version: number;
  deviceId: string;
  deviceSecret: string;
  /** Normalised edge API origin this identity belongs to. */
  edgeUrl: string;
  name: string;
  pairUrl?: string;
  createdAt: number;
  approvedAt?: number;
}

export function identityPath(stateDir: string): string {
  return join(stateDir, DEVICE_FILE_NAME);
}

function ensureStateDir(stateDir: string, logger?: Logger): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    return;
  }
  try {
    const mode = statSync(stateDir).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(stateDir, 0o700);
      logger?.warn('tightened state directory permissions to 0700', { stateDir });
    }
  } catch (error) {
    logger?.warn('could not inspect or tighten state directory permissions', { stateDir, error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIdentity(text: string): DeviceIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { version, deviceId, deviceSecret, edgeUrl, name, pairUrl, createdAt, approvedAt } = parsed;
  if (version !== IDENTITY_VERSION) return undefined;
  if (typeof deviceId !== 'string' || !isValidDeviceId(deviceId)) return undefined;
  if (typeof deviceSecret !== 'string' || deviceSecret.length === 0) return undefined;
  if (typeof edgeUrl !== 'string' || edgeUrl === '') return undefined;
  if (typeof name !== 'string') return undefined;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined;
  return {
    version: IDENTITY_VERSION,
    deviceId,
    deviceSecret,
    edgeUrl,
    name,
    ...(typeof pairUrl === 'string' ? { pairUrl } : {}),
    createdAt,
    ...(typeof approvedAt === 'number' ? { approvedAt } : {}),
  };
}

/**
 * Load the identity. A corrupt file is treated as absent (the caller registers
 * a fresh device) but is left on disk for forensics rather than silently
 * deleted.
 */
export function loadIdentity(stateDir: string, logger?: Logger): DeviceIdentity | undefined {
  ensureStateDir(stateDir, logger);
  const path = identityPath(stateDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const identity = parseIdentity(text);
  if (identity === undefined) {
    logger?.warn('device identity file is invalid; a new device will be registered', { path });
    return undefined;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
      logger?.warn('tightened device identity permissions to 0600', { path });
    }
  } catch (error) {
    logger?.warn('could not inspect or tighten device identity permissions', { path, error });
  }
  return identity;
}

export function saveIdentity(stateDir: string, identity: DeviceIdentity): void {
  ensureStateDir(stateDir);
  const path = identityPath(stateDir);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* ignore */
    }
    throw error;
  }
}