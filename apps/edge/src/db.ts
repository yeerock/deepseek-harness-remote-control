/**
 * Edge persistence. One SQLite database (node:sqlite, synchronous) under
 * --data-dir, in WAL mode, with the schema created on boot.
 *
 * Tables: owner, sessions, devices, pair_codes, audit, settings.
 * Secrets are stored hashed: device secrets and pair codes as SHA-256, owner
 * passwords as scrypt. The database never stores a DSH token (it never sees
 * one).
 */
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
// `node:sqlite` is newer than Vite's builtin list, so load it through the
// runtime's builtin table instead of a static import. Type-only imports are
// erased and keep the ergonomics.
import type { DatabaseSync as DatabaseSyncClass, SQLOutputValue } from 'node:sqlite';
import { newId } from '@dsh-rc/shared';

type SqliteModule = typeof import('node:sqlite');
const sqlite = process.getBuiltinModule('node:sqlite') as SqliteModule;
const DatabaseSync = sqlite.DatabaseSync;

export type DeviceStatus = 'pending' | 'approved' | 'revoked';
export type SessionKind = 'owner' | 'device' | 'guest';

export interface OwnerRow {
  id: number;
  name: string;
  passwordHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRow {
  id: string;
  kind: SessionKind;
  deviceId: string | null;
  csrfToken: string;
  createdAt: number;
  /** NULL for guest sessions: they do not expire on their own. */
  expiresAt: number | null;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  approvalId: string | null;
}

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  secretHash: string;
  status: DeviceStatus;
  createdAt: number;
  approvedAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
  lastConnectedAt: number | null;
  sharingEnabled: boolean;
  sharingUpdatedAt: number | null;
}

export interface InviteRow {
  id: string;
  deviceId: string;
  tokenHash: string;
  label: string;
  createdAt: number;
  /** 0 means never expires. */
  expiresAt: number;
  maxUses: number;
  uses: number;
  revokedAt: number | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRow {
  id: string;
  inviteId: string;
  deviceId: string;
  label: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  status: ApprovalStatus;
  decidedAt: number | null;
  sessionId: string | null;
}

export interface GuestSessionRow extends SessionRow {
  label: string;
}

export interface AuditRow {
  id: number;
  ts: number;
  event: string;
  deviceId: string | null;
  actor: string | null;
  ip: string | null;
  detail: string | null;
}

export interface CreateSessionInput {
  kind: SessionKind;
  deviceId: string | null;
  csrfToken: string;
  createdAt: number;
  /** NULL means no expiry (guest sessions). */
  expiresAt: number | null;
  ip: string | null;
  userAgent: string | null;
  approvalId?: string | null;
}

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')),
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  last_connected_at INTEGER,
  sharing_enabled INTEGER NOT NULL DEFAULT 0,
  sharing_updated_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'device', 'guest')),
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  approval_id TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_device ON sessions (device_id);
CREATE INDEX IF NOT EXISTS sessions_approval ON sessions (approval_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS invites_device ON invites (device_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_at INTEGER,
  session_id TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS approvals_device_status ON approvals (device_id, status);

CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS pair_codes_device ON pair_codes (device_id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  device_id TEXT,
  actor TEXT,
  ip TEXT,
  detail TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

function num(value: SQLOutputValue | undefined): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0;
}

function optNum(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : num(value);
}

function str(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function optStr(value: SQLOutputValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function toOwner(row: Record<string, SQLOutputValue> | undefined): OwnerRow | undefined {
  if (row === undefined) return undefined;
  return {
    id: num(row['id']),
    name: str(row['name']),
    passwordHash: optStr(row['password_hash']),
    createdAt: num(row['created_at']),
    updatedAt: num(row['updated_at']),
  };
}

function toSession(row: Record<string, SQLOutputValue> | undefined): SessionRow | undefined {
  if (row === undefined) return undefined;
  return {
    id: str(row['id']),
    kind: str(row['kind']) === 'owner' ? 'owner' : str(row['kind']) === 'guest' ? 'guest' : 'device',
    deviceId: optStr(row['device_id']),
    csrfToken: str(row['csrf_token']),
    createdAt: num(row['created_at']),
    expiresAt: optNum(row['expires_at']),
    lastSeenAt: num(row['last_seen_at']),
    ip: optStr(row['ip']),
    userAgent: optStr(row['user_agent']),
    approvalId: optStr(row['approval_id']),
  };
}

function toDevice(row: Record<string, SQLOutputValue> | undefined): DeviceRow | undefined {
  if (row === undefined) return undefined;
  const status = str(row['status']);
  return {
    id: str(row['id']),
    name: str(row['name']),
    platform: str(row['platform']),
    agentVersion: str(row['agent_version']),
    secretHash: str(row['secret_hash']),
    status: status === 'approved' || status === 'revoked' ? status : 'pending',
    createdAt: num(row['created_at']),
    approvedAt: optNum(row['approved_at']),
    revokedAt: optNum(row['revoked_at']),
    lastSeenAt: optNum(row['last_seen_at']),
    lastConnectedAt: optNum(row['last_connected_at']),
    sharingEnabled: num(row['sharing_enabled']) === 1,
    sharingUpdatedAt: optNum(row['sharing_updated_at']),
  };
}

function toInvite(row: Record<string, SQLOutputValue> | undefined): InviteRow | undefined {
  if (row === undefined) return undefined;
  return {
    id: str(row['id']),
    deviceId: str(row['device_id']),
    tokenHash: str(row['token_hash']),
    label: str(row['label']),
    createdAt: num(row['created_at']),
    expiresAt: num(row['expires_at']),
    maxUses: num(row['max_uses']),
    uses: num(row['uses']),
    revokedAt: optNum(row['revoked_at']),
  };
}

function toApproval(row: Record<string, SQLOutputValue> | undefined): ApprovalRow | undefined {
  if (row === undefined) return undefined;
  const status = str(row['status']);
  return {
    id: str(row['id']),
    inviteId: str(row['invite_id']),
    deviceId: str(row['device_id']),
    label: str(row['label']),
    ip: optStr(row['ip']),
    userAgent: optStr(row['user_agent']),
    createdAt: num(row['created_at']),
    status: status === 'approved' || status === 'denied' || status === 'expired' ? status : 'pending',
    decidedAt: optNum(row['decided_at']),
    sessionId: optStr(row['session_id']),
  };
}

function toAudit(row: Record<string, SQLOutputValue>): AuditRow {
  return {
    id: num(row['id']),
    ts: num(row['ts']),
    event: str(row['event']),
    deviceId: optStr(row['device_id']),
    actor: optStr(row['actor']),
    ip: optStr(row['ip']),
    detail: optStr(row['detail']),
  };
}

export class EdgeDatabase {
  readonly file: string;
  private readonly database: DatabaseSyncClass;
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'dshrc.sqlite');
    this.database = new DatabaseSync(this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
    this.purgeExpiredSessions(Date.now());
  }

  private migrate(): void {
    const current = num(this.database.prepare('PRAGMA user_version').get()?.['user_version']);
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema ${String(current)} is newer than this edge (${String(SCHEMA_VERSION)})`);
    }
    if (current === SCHEMA_VERSION) return;
    if (current === 0) {
      this.transaction(() => {
        this.database.exec(SCHEMA);
        this.database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
      });
      return;
    }
    if (current === 1) {
      this.migrateV1ToV2();
      return;
    }
    throw new Error(`unsupported database schema version ${String(current)}`);
  }

  /**
   * v1 -> v2: add sharing columns/tables and rebuild sessions so `expires_at`
   * can be NULL (guest sessions never expire) and `approval_id` exists.
   */
  private migrateV1ToV2(): void {
    this.database.exec('PRAGMA foreign_keys = OFF');
    try {
      this.transaction(() => {
        this.database.exec('ALTER TABLE devices ADD COLUMN sharing_enabled INTEGER NOT NULL DEFAULT 0');
        this.database.exec('ALTER TABLE devices ADD COLUMN sharing_updated_at INTEGER');
        this.database.exec('ALTER TABLE sessions RENAME TO sessions_v1');
        this.database.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('owner', 'device', 'guest')),
            device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
            csrf_token TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            last_seen_at INTEGER NOT NULL,
            ip TEXT,
            user_agent TEXT,
            approval_id TEXT
          ) STRICT;
          INSERT INTO sessions (id, kind, device_id, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent, approval_id)
            SELECT id, kind, device_id, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent, NULL FROM sessions_v1;
          DROP TABLE sessions_v1;
          CREATE INDEX IF NOT EXISTS sessions_device ON sessions (device_id);
          CREATE INDEX IF NOT EXISTS sessions_approval ON sessions (approval_id);
          CREATE TABLE invites (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL DEFAULT 0,
            max_uses INTEGER NOT NULL DEFAULT 1,
            uses INTEGER NOT NULL DEFAULT 0,
            revoked_at INTEGER
          ) STRICT;
          CREATE INDEX IF NOT EXISTS invites_device ON invites (device_id);
          CREATE TABLE approvals (
            id TEXT PRIMARY KEY,
            invite_id TEXT NOT NULL,
            device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            ip TEXT,
            user_agent TEXT,
            created_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
            decided_at INTEGER,
            session_id TEXT
          ) STRICT;
          CREATE INDEX IF NOT EXISTS approvals_device_status ON approvals (device_id, status);
        `);
        this.database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
      });
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch {
      /* already closed */
    }
  }

  transaction<T>(fn: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw error;
    }
  }

  /* ------------------------------- settings ------------------------------- */

  getSetting(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row === undefined ? undefined : optStr(row['value']) ?? undefined;
  }

  setSetting(key: string, value: string, now = Date.now()): void {
    this.database
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, now);
  }

  deleteSetting(key: string): void {
    this.database.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  /** Read a setting, generating and persisting it on first use. */
  ensureSetting(key: string, generate: () => string, now = Date.now()): string {
    const existing = this.getSetting(key);
    if (existing !== undefined && existing !== '') return existing;
    const value = generate();
    this.setSetting(key, value, now);
    return value;
  }

  /* -------------------------------- owner --------------------------------- */

  hasOwner(): boolean {
    return this.database.prepare('SELECT 1 AS present FROM owner WHERE id = 1').get() !== undefined;
  }

  getOwner(): OwnerRow | undefined {
    return toOwner(this.database.prepare('SELECT * FROM owner WHERE id = 1').get());
  }

  createOwner(name: string, passwordHash: string | null, now: number): OwnerRow {
    this.database
      .prepare('INSERT INTO owner (id, name, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
      .run(name, passwordHash, now, now);
    const owner = this.getOwner();
    if (owner === undefined) throw new Error('failed to create owner');
    return owner;
  }

  /* ------------------------------- sessions ------------------------------- */

  createSession(input: CreateSessionInput): SessionRow {
    const id = newId('sess', 32);
    this.database
      .prepare(
        'INSERT INTO sessions (id, kind, device_id, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.kind,
        input.deviceId,
        input.csrfToken,
        input.createdAt,
        input.expiresAt,
        input.createdAt,
        input.ip,
        input.userAgent,
        input.approvalId ?? null,
      );
    const session = this.getSession(id);
    if (session === undefined) throw new Error('failed to create session');
    return session;
  }

  getSession(id: string): SessionRow | undefined {
    return toSession(this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
  }

  touchSession(id: string, now: number): void {
    this.database.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  deleteSession(id: string): void {
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  deleteSessionsForDevice(deviceId: string): void {
    this.database.prepare('DELETE FROM sessions WHERE device_id = ?').run(deviceId);
  }

  purgeExpiredSessions(now: number): void {
    // expires_at IS NULL is the guest "never expires" marker.
    this.database.prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  /** Guest sessions for a device, with the approval label joined in. */
  listGuestSessions(deviceId: string): GuestSessionRow[] {
    const rows = this.database
      .prepare(
        `SELECT s.*, a.label AS approval_label
           FROM sessions s LEFT JOIN approvals a ON a.session_id = s.id
          WHERE s.kind = 'guest' AND s.device_id = ?
          ORDER BY s.created_at ASC`,
      )
      .all(deviceId);
    const out: GuestSessionRow[] = [];
    for (const row of rows) {
      const session = toSession(row);
      if (session === undefined) continue;
      out.push({ ...session, label: optStr(row['approval_label']) ?? 'Guest' });
    }
    return out;
  }

  getGuestSessionLabel(sessionId: string): string | undefined {
    const row = this.database
      .prepare("SELECT a.label AS label FROM sessions s LEFT JOIN approvals a ON a.session_id = s.id WHERE s.id = ? AND s.kind = 'guest'")
      .get(sessionId);
    return row === undefined ? undefined : optStr(row['label']) ?? undefined;
  }

  deleteGuestSession(sessionId: string, deviceId: string): boolean {
    const result = this.database
      .prepare("DELETE FROM sessions WHERE id = ? AND device_id = ? AND kind = 'guest'")
      .run(sessionId, deviceId);
    return Number(result.changes) > 0;
  }

  guestSessionIdsForDevice(deviceId: string): string[] {
    return this.database
      .prepare("SELECT id FROM sessions WHERE device_id = ? AND kind = 'guest'")
      .all(deviceId)
      .map((row) => str(row['id']));
  }

  deleteGuestSessionsForDevice(deviceId: string): number {
    const result = this.database
      .prepare("DELETE FROM sessions WHERE device_id = ? AND kind = 'guest'")
      .run(deviceId);
    return Number(result.changes);
  }

  /* -------------------------------- devices ------------------------------- */

  insertDevice(input: {
    id: string;
    name: string;
    platform: string;
    agentVersion: string;
    secretHash: string;
    status: DeviceStatus;
    createdAt: number;
  }): DeviceRow {
    this.database
      .prepare('INSERT INTO devices (id, name, platform, agent_version, secret_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, input.name, input.platform, input.agentVersion, input.secretHash, input.status, input.createdAt);
    const device = this.getDevice(input.id);
    if (device === undefined) throw new Error('failed to create device');
    return device;
  }

  getDevice(id: string): DeviceRow | undefined {
    return toDevice(this.database.prepare('SELECT * FROM devices WHERE id = ?').get(id));
  }

  listDevices(): DeviceRow[] {
    return this.database
      .prepare('SELECT * FROM devices ORDER BY created_at DESC')
      .all()
      .map((row) => toDevice(row))
      .filter((device): device is DeviceRow => device !== undefined);
  }

  approveDevice(id: string, now: number): DeviceRow | undefined {
    this.database.prepare("UPDATE devices SET status = 'approved', approved_at = COALESCE(approved_at, ?), revoked_at = NULL WHERE id = ?").run(now, id);
    return this.getDevice(id);
  }

  revokeDevice(id: string, now: number): DeviceRow | undefined {
    this.database.prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, id);
    return this.getDevice(id);
  }

  markTunnelConnected(id: string, now: number): void {
    this.database.prepare('UPDATE devices SET last_connected_at = ?, last_seen_at = ? WHERE id = ?').run(now, now, id);
  }

  markTunnelDisconnected(id: string, now: number): void {
    this.database.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  deletePairCodesForDevice(deviceId: string): void {
    this.database.prepare('DELETE FROM pair_codes WHERE device_id = ?').run(deviceId);
  }

  setSharingEnabled(id: string, enabled: boolean, now: number): DeviceRow | undefined {
    this.database
      .prepare('UPDATE devices SET sharing_enabled = ?, sharing_updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now, id);
    return this.getDevice(id);
  }

  /* ------------------------------- pair codes ----------------------------- */

  insertPairCode(codeHash: string, deviceId: string, createdAt: number, expiresAt: number): void {
    this.database
      .prepare('INSERT INTO pair_codes (code_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(codeHash, deviceId, createdAt, expiresAt);
  }

  /** Atomically consume a pair code; returns the device it belongs to. */
  redeemPairCode(codeHash: string, now: number): string | undefined {
    return this.transaction(() => {
      const row = this.database
        .prepare('SELECT device_id, used_at, expires_at FROM pair_codes WHERE code_hash = ?')
        .get(codeHash);
      if (row === undefined) return undefined;
      if (optNum(row['used_at']) !== null) return undefined;
      if (num(row['expires_at']) <= now) return undefined;
      const result = this.database.prepare('UPDATE pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(now, codeHash);
      if (Number(result.changes) === 0) return undefined;
      return optStr(row['device_id']) ?? undefined;
    });
  }

  /** Test/diagnostic helper. */
  getPairCode(codeHash: string): { deviceId: string; usedAt: number | null; expiresAt: number } | undefined {
    const row = this.database.prepare('SELECT device_id, used_at, expires_at FROM pair_codes WHERE code_hash = ?').get(codeHash);
    if (row === undefined) return undefined;
    return { deviceId: optStr(row['device_id']) ?? '', usedAt: optNum(row['used_at']), expiresAt: num(row['expires_at']) };
  }

  /* -------------------------------- invites ------------------------------- */

  insertInvite(input: {
    id: string;
    deviceId: string;
    tokenHash: string;
    label: string;
    createdAt: number;
    expiresAt: number;
    maxUses: number;
  }): InviteRow {
    this.database
      .prepare('INSERT INTO invites (id, device_id, token_hash, label, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
      .run(input.id, input.deviceId, input.tokenHash, input.label, input.createdAt, input.expiresAt, input.maxUses);
    const invite = this.getInvite(input.id);
    if (invite === undefined) throw new Error('failed to create invite');
    return invite;
  }

  getInvite(id: string): InviteRow | undefined {
    return toInvite(this.database.prepare('SELECT * FROM invites WHERE id = ?').get(id));
  }

  getInviteByTokenHash(tokenHash: string): InviteRow | undefined {
    return toInvite(this.database.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash));
  }

  listInvitesForDevice(deviceId: string): InviteRow[] {
    return this.database
      .prepare('SELECT * FROM invites WHERE device_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
      .all(deviceId)
      .map((row) => toInvite(row))
      .filter((invite): invite is InviteRow => invite !== undefined);
  }

  /** Atomically validate and consume one use of an invite. */
  consumeInviteUse(tokenHash: string, now: number): InviteRow | undefined {
    return this.transaction(() => {
      const invite = this.getInviteByTokenHash(tokenHash);
      if (invite === undefined) return undefined;
      if (invite.revokedAt !== null) return undefined;
      if (invite.expiresAt !== 0 && invite.expiresAt <= now) return undefined;
      if (invite.uses >= invite.maxUses) return undefined;
      const result = this.database
        .prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL')
        .run(invite.id);
      if (Number(result.changes) === 0) return undefined;
      return this.getInvite(invite.id);
    });
  }

  /** Revoke an invite; returns true when this call changed it. */
  revokeInvite(inviteId: string, now: number): boolean {
    const result = this.database
      .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, inviteId);
    return Number(result.changes) > 0;
  }

  revokeInvitesForDevice(deviceId: string, now: number): number {
    const result = this.database
      .prepare('UPDATE invites SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
      .run(now, deviceId);
    return Number(result.changes);
  }

  /* ------------------------------- approvals ------------------------------ */

  insertApproval(input: {
    id: string;
    inviteId: string;
    deviceId: string;
    label: string;
    ip: string | null;
    userAgent: string | null;
    createdAt: number;
  }): ApprovalRow {
    this.database
      .prepare("INSERT INTO approvals (id, invite_id, device_id, label, ip, user_agent, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')")
      .run(input.id, input.inviteId, input.deviceId, input.label, input.ip, input.userAgent, input.createdAt);
    const approval = this.getApproval(input.id);
    if (approval === undefined) throw new Error('failed to create approval');
    return approval;
  }

  getApproval(id: string): ApprovalRow | undefined {
    return toApproval(this.database.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
  }

  listPendingApprovalsForDevice(deviceId: string): ApprovalRow[] {
    return this.database
      .prepare("SELECT * FROM approvals WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(deviceId)
      .map((row) => toApproval(row))
      .filter((approval): approval is ApprovalRow => approval !== undefined);
  }

  decideApproval(id: string, status: 'approved' | 'denied' | 'expired', now: number, sessionId: string | null): boolean {
    const result = this.database
      .prepare("UPDATE approvals SET status = ?, decided_at = ?, session_id = ? WHERE id = ? AND status = 'pending'")
      .run(status, now, sessionId, id);
    return Number(result.changes) > 0;
  }

  expirePendingApprovalsForInvite(inviteId: string, now: number): number {
    const result = this.database
      .prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE invite_id = ? AND status = 'pending'")
      .run(now, inviteId);
    return Number(result.changes);
  }

  expirePendingApprovalsForDevice(deviceId: string, now: number): number {
    const result = this.database
      .prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE device_id = ? AND status = 'pending'")
      .run(now, deviceId);
    return Number(result.changes);
  }

  /* --------------------------------- audit -------------------------------- */

  addAudit(input: {
    event: string;
    deviceId?: string | null;
    actor?: string | null;
    ip?: string | null;
    detail?: string | null;
    ts?: number;
  }): void {
    this.database
      .prepare('INSERT INTO audit (ts, event, device_id, actor, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.ts ?? Date.now(), input.event, input.deviceId ?? null, input.actor ?? null, input.ip ?? null, input.detail ?? null);
  }

  /** Delete audit rows older than the cutoff; returns the number removed. */
  pruneAudit(olderThan: number): number {
    const result = this.database.prepare('DELETE FROM audit WHERE ts < ?').run(olderThan);
    return Number(result.changes);
  }

  listAudit(limit = 50): AuditRow[] {
    return this.database.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(toAudit);
  }

  /** Diagnostics used by /v1/edge. */
  countDevices(): { total: number; approved: number; pending: number; revoked: number } {
    const rows = this.database.prepare('SELECT status, COUNT(*) AS count FROM devices GROUP BY status').all();
    const counts = { total: 0, approved: 0, pending: 0, revoked: 0 };
    for (const row of rows) {
      const count = num(row['count']);
      counts.total += count;
      const status = str(row['status']);
      if (status === 'approved' || status === 'pending' || status === 'revoked') counts[status] += count;
    }
    return counts;
  }
}
