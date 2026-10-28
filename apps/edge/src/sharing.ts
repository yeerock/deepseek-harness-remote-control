/**
 * Per-device sharing: invites, approvals and permanent guest sessions.
 *
 * A pair code gets a browser into the device list; an invite gets one guest
 * into one device. Invite tokens are bearer capabilities (hashed at rest), and
 * claiming one only creates a pending approval. The host approves with the
 * device secret; approval mints a guest session that never expires on its own.
 */
import {
  newId,
  randomToken,
  sha256Hex,
  type Logger,
} from '@dsh-rc/shared';
import type {
  ApprovalRow,
  DeviceRow,
  EdgeDatabase,
  GuestSessionRow,
  InviteRow,
  SessionRow,
} from './db.js';

export const MAX_INVITE_LABEL = 64;
export const DEFAULT_INVITE_TTL_SECONDS = 60 * 60;
export const MIN_INVITE_TTL_SECONDS = 60;
export const MAX_INVITE_TTL_SECONDS = 86_400;
export const DEFAULT_INVITE_MAX_USES = 1;
export const MAX_INVITE_MAX_USES = 10;
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface SharingMeta {
  ip: string | null;
  userAgent?: string | null;
  actor: string | null;
  now?: number;
}

export interface InviteInput {
  label: string;
  ttlSeconds: number;
  maxUses: number;
}

export interface InviteView {
  id: string;
  label: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

export interface PendingApprovalView {
  id: string;
  label: string;
  ip: string | null;
  createdAt: number;
}

export interface ActiveGuestView {
  sessionId: string;
  label: string;
  ip: string | null;
  since: number;
  expiresAt: null;
}

export interface SharingSummary {
  enabled: boolean;
  publicUrl: string;
  invites: InviteView[];
  pendingApprovals: PendingApprovalView[];
  activeGuests: ActiveGuestView[];
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function validateInviteInput(body: unknown): { ok: true; value: InviteInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const rawLabel = record['label'];
  const trimmedLabel = rawLabel === undefined ? 'Guest' : typeof rawLabel === 'string' ? rawLabel.trim() : undefined;
  const label = trimmedLabel === '' ? 'Guest' : trimmedLabel;
  if (label === undefined || label.length > MAX_INVITE_LABEL || CONTROL_RE.test(label)) {
    return { ok: false, error: `label must be 1-${String(MAX_INVITE_LABEL)} printable characters` };
  }
  const ttlSeconds = record['ttlSeconds'] === undefined
    ? DEFAULT_INVITE_TTL_SECONDS
    : numberField(record['ttlSeconds']);
  if (ttlSeconds === undefined || (ttlSeconds !== 0 && (ttlSeconds < MIN_INVITE_TTL_SECONDS || ttlSeconds > MAX_INVITE_TTL_SECONDS))) {
    return { ok: false, error: `ttlSeconds must be 0 (never) or ${String(MIN_INVITE_TTL_SECONDS)}-${String(MAX_INVITE_TTL_SECONDS)}` };
  }
  const maxUses = record['maxUses'] === undefined ? DEFAULT_INVITE_MAX_USES : numberField(record['maxUses']);
  if (maxUses === undefined || maxUses < 1 || maxUses > MAX_INVITE_MAX_USES) {
    return { ok: false, error: `maxUses must be 1-${String(MAX_INVITE_MAX_USES)}` };
  }
  return { ok: true, value: { label, ttlSeconds, maxUses } };
}

export function validateApprovalInput(body: unknown): { ok: true; decision: 'approve' | 'deny' } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const decision = (body as Record<string, unknown>)['decision'];
  if (decision !== 'approve' && decision !== 'deny') return { ok: false, error: 'decision must be "approve" or "deny"' };
  return { ok: true, decision };
}

function inviteExpired(invite: InviteRow, now: number): boolean {
  return invite.expiresAt !== 0 && invite.expiresAt <= now;
}

export class SharingService {
  constructor(
    private readonly db: EdgeDatabase,
    private readonly logger: Logger,
  ) {}

  summary(device: DeviceRow, publicUrl: string): SharingSummary {
    const invites = this.db.listInvitesForDevice(device.id).map((invite) => ({
      id: invite.id,
      label: invite.label,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      uses: invite.uses,
    }));
    const pendingApprovals = this.db.listPendingApprovalsForDevice(device.id).map((approval) => ({
      id: approval.id,
      label: approval.label,
      ip: approval.ip,
      createdAt: approval.createdAt,
    }));
    const activeGuests = this.db.listGuestSessions(device.id).map((session) => ({
      sessionId: session.id,
      label: session.label,
      ip: session.ip,
      since: session.createdAt,
      expiresAt: null,
    }));
    return { enabled: device.sharingEnabled, publicUrl, invites, pendingApprovals, activeGuests };
  }

  createInvite(
    device: DeviceRow,
    input: InviteInput,
    meta: SharingMeta,
    publicUrl: string,
  ): { invite: InviteRow; token: string; url: string } {
    const now = meta.now ?? Date.now();
    if (!device.sharingEnabled) {
      throw Object.assign(new Error('sharing is disabled for this device'), { status: 409, code: 'SHARING_DISABLED' });
    }
    const token = randomToken(32);
    const invite = this.db.insertInvite({
      id: newId('inv'),
      deviceId: device.id,
      tokenHash: sha256Hex(token),
      label: input.label,
      createdAt: now,
      expiresAt: input.ttlSeconds === 0 ? 0 : now + input.ttlSeconds * 1000,
      maxUses: input.maxUses,
    });
    this.db.addAudit({
      event: 'invite-created',
      deviceId: device.id,
      actor: meta.actor,
      ip: meta.ip,
      detail: `${input.label} · ttl ${input.ttlSeconds === 0 ? 'never' : `${String(input.ttlSeconds)}s`} · uses ${String(input.maxUses)}`,
      ts: now,
    });
    this.logger.info('invite created', { deviceId: device.id, inviteId: invite.id, label: invite.label });
    return { invite, token, url: `${publicUrl.replace(/\/+$/, '')}/i/${token}` };
  }

  deleteInvite(deviceId: string, inviteId: string, meta: SharingMeta): { ok: boolean; pendingExpired: number } {
    const invite = this.db.getInvite(inviteId);
    if (invite === undefined || invite.deviceId !== deviceId) return { ok: false, pendingExpired: 0 };
    const now = meta.now ?? Date.now();
    const changed = this.db.revokeInvite(inviteId, now);
    const pendingExpired = this.db.expirePendingApprovalsForInvite(inviteId, now);
    if (changed) {
      this.db.addAudit({ event: 'invite-revoked', deviceId, actor: meta.actor, ip: meta.ip, detail: inviteId, ts: now });
      this.logger.info('invite revoked', { deviceId, inviteId });
    }
    return { ok: true, pendingExpired };
  }

  claimInvite(token: string, meta: SharingMeta): { ok: true; invite: InviteRow; approval: ApprovalRow } | { ok: false; status: number; error: string } {
    if (!INVITE_TOKEN_RE.test(token)) return { ok: false, status: 404, error: 'INVITE_NOT_FOUND' };
    const now = meta.now ?? Date.now();
    const invite = this.db.getInviteByTokenHash(sha256Hex(token));
    if (invite === undefined) return { ok: false, status: 404, error: 'INVITE_NOT_FOUND' };
    const device = this.db.getDevice(invite.deviceId);
    if (device === undefined || device.status !== 'approved' || !device.sharingEnabled) {
      return { ok: false, status: 410, error: 'INVITE_EXPIRED' };
    }
    if (invite.revokedAt !== null || inviteExpired(invite, now) || invite.uses >= invite.maxUses) {
      return { ok: false, status: 410, error: 'INVITE_EXPIRED' };
    }
    const consumed = this.db.consumeInviteUse(invite.tokenHash, now);
    if (consumed === undefined) return { ok: false, status: 410, error: 'INVITE_EXPIRED' };
    const approval = this.db.insertApproval({
      id: newId('apr'),
      inviteId: invite.id,
      deviceId: invite.deviceId,
      label: invite.label,
      ip: meta.ip,
      userAgent: meta.userAgent ?? null,
      createdAt: now,
    });
    this.db.addAudit({
      event: 'invite-claimed',
      deviceId: invite.deviceId,
      actor: 'guest',
      ip: meta.ip,
      detail: `${approval.id} · ${invite.label}`,
      ts: now,
    });
    this.logger.info('invite claimed', { deviceId: invite.deviceId, inviteId: invite.id, approvalId: approval.id });
    return { ok: true, invite: consumed, approval };
  }

  /** Existing pending approval for a claim cookie, if it still matches the invite. */
  pendingApprovalForClaim(token: string, approvalId: string): ApprovalRow | undefined {
    const invite = this.db.getInviteByTokenHash(sha256Hex(token));
    if (invite === undefined) return undefined;
    const approval = this.db.getApproval(approvalId);
    if (approval === undefined || approval.inviteId !== invite.id) return undefined;
    return approval;
  }

  approvalStatus(
    token: string,
    approvalId: string,
    now = Date.now(),
  ): { status: 'pending' | 'approved' | 'denied' | 'expired'; deviceId?: string; sessionId?: string } {
    const invite = this.db.getInviteByTokenHash(sha256Hex(token));
    if (invite === undefined) return { status: 'expired' };
    const approval = this.db.getApproval(approvalId);
    if (approval === undefined || approval.inviteId !== invite.id) return { status: 'expired' };
    if (approval.status === 'approved') {
      const session = approval.sessionId === null ? undefined : this.db.getSession(approval.sessionId);
      const device = this.db.getDevice(approval.deviceId);
      if (
        session !== undefined
        && session.kind === 'guest'
        && session.deviceId === approval.deviceId
        && device !== undefined
        && device.status === 'approved'
        && device.sharingEnabled
      ) {
        return { status: 'approved', deviceId: approval.deviceId, sessionId: session.id };
      }
      return { status: 'expired' };
    }
    if (approval.status === 'denied' || approval.status === 'expired') return { status: approval.status };
    if (inviteExpired(invite, now) || invite.revokedAt !== null) return { status: 'expired' };
    const device = this.db.getDevice(invite.deviceId);
    if (device === undefined || device.status !== 'approved' || !device.sharingEnabled) return { status: 'expired' };
    return { status: 'pending', deviceId: invite.deviceId };
  }

  decideApproval(
    deviceId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    meta: SharingMeta,
  ): { ok: true; sessionId?: string } | { ok: false; status: number; error: string } {
    const now = meta.now ?? Date.now();
    try {
      return this.db.transaction(() => {
        const approval = this.db.getApproval(approvalId);
        if (approval === undefined || approval.deviceId !== deviceId) {
          return { ok: false as const, status: 404, error: 'APPROVAL_NOT_FOUND' };
        }
        if (approval.status !== 'pending') {
          return { ok: false as const, status: 409, error: 'APPROVAL_ALREADY_DECIDED' };
        }
        const invite = this.db.getInvite(approval.inviteId);
        if (invite === undefined || invite.revokedAt !== null || (invite.expiresAt !== 0 && invite.expiresAt <= now)) {
          this.db.decideApproval(approval.id, 'expired', now, null);
          return { ok: false as const, status: 409, error: 'INVITE_EXPIRED' };
        }
        const device = this.db.getDevice(deviceId);
        if (device === undefined || device.status !== 'approved' || !device.sharingEnabled) {
          return { ok: false as const, status: 409, error: 'SHARING_DISABLED' };
        }
        if (decision === 'deny') {
          this.db.decideApproval(approval.id, 'denied', now, null);
          this.db.addAudit({ event: 'approval-denied', deviceId, actor: meta.actor, ip: meta.ip, detail: approval.id, ts: now });
          this.logger.info('guest approval denied', { deviceId, approvalId: approval.id });
          return { ok: true as const };
        }
        const session = this.db.createSession({
          kind: 'guest',
          deviceId,
          csrfToken: randomToken(24),
          createdAt: now,
          expiresAt: null,
          ip: approval.ip,
          userAgent: approval.userAgent,
          approvalId: approval.id,
        });
        const changed = this.db.decideApproval(approval.id, 'approved', now, session.id);
        if (!changed) return { ok: false as const, status: 409, error: 'APPROVAL_ALREADY_DECIDED' };
        this.db.addAudit({
          event: 'approval-approved',
          deviceId,
          actor: meta.actor,
          ip: meta.ip,
          detail: `${approval.id} · ${session.id} · ${approval.label}`,
          ts: now,
        });
        this.logger.info('guest approved', { deviceId, approvalId: approval.id, sessionId: session.id });
        return { ok: true as const, sessionId: session.id };
      });
    } catch (error) {
      this.logger.warn('could not decide guest approval', { deviceId, approvalId, error });
      return { ok: false, status: 500, error: 'APPROVAL_FAILED' };
    }
  }

  revokeGuest(deviceId: string, sessionId: string, meta: SharingMeta): boolean {
    const now = meta.now ?? Date.now();
    const label = this.db.getGuestSessionLabel(sessionId) ?? 'Guest';
    if (!this.db.deleteGuestSession(sessionId, deviceId)) return false;
    this.db.addAudit({
      event: 'guest-revoked',
      deviceId,
      actor: meta.actor,
      ip: meta.ip,
      detail: `${sessionId} · ${label}`,
      ts: now,
    });
    this.logger.warn('guest revoked', { deviceId, sessionId });
    return true;
  }

  revokeAllGuests(deviceId: string, meta: SharingMeta): { revoked: number; sessionIds: string[] } {
    const now = meta.now ?? Date.now();
    const sessionIds = this.db.guestSessionIdsForDevice(deviceId);
    for (const sessionId of sessionIds) {
      const label = this.db.getGuestSessionLabel(sessionId) ?? 'Guest';
      this.db.deleteGuestSession(sessionId, deviceId);
      this.db.addAudit({
        event: 'guest-revoked',
        deviceId,
        actor: meta.actor,
        ip: meta.ip,
        detail: `${sessionId} · ${label} · revoke-all`,
        ts: now,
      });
    }
    if (sessionIds.length > 0) this.logger.warn('all guests revoked', { deviceId, revoked: sessionIds.length });
    return { revoked: sessionIds.length, sessionIds };
  }

  setEnabled(device: DeviceRow, enabled: boolean, meta: SharingMeta): { enabled: boolean; sessionIds: string[]; revokedInvites: number; pendingExpired: number } {
    const now = meta.now ?? Date.now();
    if (enabled) {
      this.db.setSharingEnabled(device.id, true, now);
      this.db.addAudit({ event: 'sharing-enabled', deviceId: device.id, actor: meta.actor, ip: meta.ip, ts: now });
      this.logger.info('sharing enabled', { deviceId: device.id });
      return { enabled: true, sessionIds: [], revokedInvites: 0, pendingExpired: 0 };
    }
    const result = this.db.transaction(() => {
      const sessionIds = this.db.guestSessionIdsForDevice(device.id);
      const revokedInvites = this.db.revokeInvitesForDevice(device.id, now);
      const pendingExpired = this.db.expirePendingApprovalsForDevice(device.id, now);
      for (const sessionId of sessionIds) this.db.deleteGuestSession(sessionId, device.id);
      this.db.setSharingEnabled(device.id, false, now);
      this.db.addAudit({
        event: 'sharing-disabled',
        deviceId: device.id,
        actor: meta.actor,
        ip: meta.ip,
        detail: `revoked ${String(sessionIds.length)} guests and ${String(revokedInvites)} invites`,
        ts: now,
      });
      return { sessionIds, revokedInvites, pendingExpired };
    });
    if (result.sessionIds.length > 0) this.logger.warn('sharing disabled; guests revoked', { deviceId: device.id, guests: result.sessionIds.length });
    return { enabled: false, ...result };
  }

  /** Device revocation also tears down everything shared from that device. */
  revokeForDevice(deviceId: string, meta: SharingMeta): { sessionIds: string[]; revokedInvites: number } {
    const device = this.db.getDevice(deviceId);
    if (device === undefined) return { sessionIds: [], revokedInvites: 0 };
    const result = this.setEnabled({ ...device, sharingEnabled: true }, false, { ...meta, actor: meta.actor ?? 'owner' });
    return { sessionIds: result.sessionIds, revokedInvites: result.revokedInvites };
  }

  guestSessionLabel(sessionId: string): string | undefined {
    return this.db.getGuestSessionLabel(sessionId);
  }

  guestSessions(deviceId: string): GuestSessionRow[] {
    return this.db.listGuestSessions(deviceId);
  }

  guestSession(sessionId: string): SessionRow | undefined {
    const session = this.db.getSession(sessionId);
    return session?.kind === 'guest' ? session : undefined;
  }
}
