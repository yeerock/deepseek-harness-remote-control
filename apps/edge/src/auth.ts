/**
 * Browser authentication, CSRF and first-run setup.
 *
 * Owner identity lives in SQLite; the browser holds a signed session id in an
 * HttpOnly cookie. The HMAC key is generated on first boot and persisted in
 * settings, so sessions survive an edge restart (until their 30-day expiry).
 * Device-bound sessions are created by the pair flow and can reach exactly one
 * `/d/<deviceId>/` mount.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  newId,
  parseCookies,
  randomToken,
  requestHeader,
  safeEqual,
  serializeCookie,
  sha256Hex,
  signPayload,
  tokenMatchesHash,
  verifyPayload,
  isSecureSocket,
  requestOrigin,
  type Logger,
} from '@dsh-link/shared';
import type { EdgeConfig } from './config.js';
import type { DeviceRow, EdgeDatabase, OwnerRow, SessionKind, SessionRow } from './db.js';

export const SESSION_COOKIE = 'dshlink_session';
export const CSRF_COOKIE = 'dshlink_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_FIELD = 'csrf';

const COOKIE_VALUE_RE = /^[A-Za-z0-9_.-]{16,1024}$/;
const CSRF_VALUE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SETUP_CODE_HASH_KEY = 'setup_code_hash';
const SETUP_CODE_EXPIRES_KEY = 'setup_code_expires_at';
const SESSION_SECRET_KEY = 'session_secret';
const EDGE_ID_KEY = 'edge_id';

interface SessionCookiePayload {
  sid: string;
  exp: number;
  v: number;
}

export interface PasswordHash {
  hash: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1] ?? '';
  const hashHex = parts[2] ?? '';
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false;
  try {
    const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    return safeEqual(derived.toString('hex'), hashHex);
  } catch {
    return false;
  }
}

/** Readable but high-entropy: 12 base32 chars, groups of four. */
function generateSetupCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
  now: number;
}

export class AuthService {
  readonly edgeId: string;
  private readonly sessionSecret: string;
  private pendingSetupCode: string | undefined;

  constructor(
    private readonly config: EdgeConfig,
    private readonly db: EdgeDatabase,
    private readonly logger: Logger,
  ) {
    this.sessionSecret = db.ensureSetting(SESSION_SECRET_KEY, () => randomToken(32));
    this.edgeId = db.ensureSetting(EDGE_ID_KEY, () => newId('edge'));
    this.prepareSetupCode();
  }

  /**
   * Generate (or adopt) the one-time setup code when no owner exists yet.
   * The plaintext stays in memory only so main.ts can print it once.
   */
  private prepareSetupCode(): void {
    if (this.db.hasOwner()) {
      this.db.deleteSetting(SETUP_CODE_HASH_KEY);
      this.db.deleteSetting(SETUP_CODE_EXPIRES_KEY);
      this.pendingSetupCode = undefined;
      return;
    }
    // The plaintext of a generated code only ever exists in memory, so every
    // boot before setup generates and prints a fresh one (the previous code is
    // invalidated). An explicitly supplied --setup-code is used verbatim.
    const code = this.config.setupCode ?? generateSetupCode();
    this.storeSetupCode(code);
    this.pendingSetupCode = code;
  }

  private storeSetupCode(code: string): void {
    const now = Date.now();
    this.db.setSetting(SETUP_CODE_HASH_KEY, sha256Hex(code), now);
    this.db.setSetting(SETUP_CODE_EXPIRES_KEY, String(now + this.config.setupCodeTtlMs), now);
  }

  /** Present only while setup is incomplete; printed exactly once by main.ts. */
  get setupCode(): string | undefined {
    return this.db.hasOwner() ? undefined : this.pendingSetupCode;
  }

  get setupComplete(): boolean {
    return this.db.hasOwner();
  }

  verifySetupCode(code: string): boolean {
    if (this.db.hasOwner()) return false;
    const storedHash = this.db.getSetting(SETUP_CODE_HASH_KEY);
    const expiresAt = Number(this.db.getSetting(SETUP_CODE_EXPIRES_KEY) ?? '0');
    if (storedHash === undefined || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    return tokenMatchesHash(code, storedHash);
  }

  /** Create the owner row and the first owner session atomically. */
  completeSetup(name: string, password: string | null, meta: SessionMeta): { owner: OwnerRow; session: SessionRow } {
    const passwordHash = password === null ? null : hashPassword(password);
    return this.db.transaction(() => {
      if (this.db.hasOwner()) throw new Error('owner already configured');
      const owner = this.db.createOwner(name, passwordHash, meta.now);
      const session = this.createSession('owner', null, meta);
      this.db.deleteSetting(SETUP_CODE_HASH_KEY);
      this.db.deleteSetting(SETUP_CODE_EXPIRES_KEY);
      this.pendingSetupCode = undefined;
      return { owner, session };
    });
  }

  hasOwnerPassword(): boolean {
    const owner = this.db.getOwner();
    return owner?.passwordHash != null;
  }

  verifyOwnerPassword(password: string): boolean {
    const owner = this.db.getOwner();
    if (owner?.passwordHash == null) return false;
    return verifyPassword(password, owner.passwordHash);
  }

  createSession(kind: SessionKind, deviceId: string | null, meta: SessionMeta): SessionRow {
    return this.db.createSession({
      kind,
      deviceId,
      csrfToken: randomToken(24),
      createdAt: meta.now,
      expiresAt: meta.now + this.config.sessionTtlMs,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /* --------------------------------- cookies -------------------------------- */

  private isSecure(request: IncomingMessage): boolean {
    if (this.config.publicUrl !== '') return this.config.publicUrl.startsWith('https://');
    if (this.config.trustProxy) return (requestHeader(request, 'x-forwarded-proto') ?? 'http').startsWith('https');
    return isSecureSocket(request.socket);
  }

  private cookieOptions(request: IncomingMessage, maxAgeSeconds: number) {
    return {
      maxAgeSeconds,
      path: '/',
      httpOnly: true,
      secure: this.isSecure(request),
      sameSite: 'Lax' as const,
    };
  }

  readSession(request: IncomingMessage, now = Date.now()): SessionRow | undefined {
    const cookies = parseCookies(requestHeader(request, 'cookie'));
    const raw = cookies[SESSION_COOKIE];
    if (raw === undefined || !COOKIE_VALUE_RE.test(raw)) return undefined;
    const payload = verifyPayload<SessionCookiePayload>(this.sessionSecret, raw, Math.floor(now / 1000));
    if (payload === undefined || typeof payload.sid !== 'string') return undefined;
    const session = this.db.getSession(payload.sid);
    if (session === undefined) return undefined;
    if (session.expiresAt <= now) {
      this.db.deleteSession(session.id);
      return undefined;
    }
    if (now - session.lastSeenAt > 60_000) this.db.touchSession(session.id, now);
    return session;
  }

  sessionCookie(request: IncomingMessage, session: SessionRow): string {
    const exp = Math.floor(session.expiresAt / 1000);
    const value = signPayload(this.sessionSecret, { sid: session.id, exp, v: 1 } satisfies SessionCookiePayload);
    const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    return serializeCookie(SESSION_COOKIE, value, this.cookieOptions(request, maxAge));
  }

  setSessionCookie(request: IncomingMessage, response: ServerResponse, session: SessionRow): void {
    response.setHeader('set-cookie', this.sessionCookie(request, session));
  }

  clearSessionCookie(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, '', { ...this.cookieOptions(request, 0), maxAgeSeconds: 0 }),
    );
  }

  /** Issue (or reuse) the double-submit CSRF cookie and return its token. */
  ensureCsrf(request: IncomingMessage, response: ServerResponse): string {
    const existing = parseCookies(requestHeader(request, 'cookie'))[CSRF_COOKIE];
    if (existing !== undefined && CSRF_VALUE_RE.test(existing)) return existing;
    const token = randomToken(24);
    response.setHeader(
      'set-cookie',
      serializeCookie(CSRF_COOKIE, token, this.cookieOptions(request, Math.floor(this.config.sessionTtlMs / 1000))),
    );
    return token;
  }

  csrfCookie(request: IncomingMessage): string | undefined {
    const value = parseCookies(requestHeader(request, 'cookie'))[CSRF_COOKIE];
    return value !== undefined && CSRF_VALUE_RE.test(value) ? value : undefined;
  }

  /** Origin allow-list: browsers send Origin on state-changing requests. */
  originAllowed(request: IncomingMessage): boolean {
    const originHeader = requestHeader(request, 'origin');
    const site = requestHeader(request, 'sec-fetch-site');
    if (originHeader === undefined || originHeader === '') {
      // Non-browser clients (agent CLI, curl) have no Origin. A browser that
      // omits Origin but declares a cross-site fetch is still rejected.
      return site === undefined || site === 'same-origin' || site === 'none' || site === 'same-site';
    }
    if (originHeader === 'null') return false;
    const expected = requestOrigin(request, this.config.publicUrl, this.config.trustProxy);
    try {
      return new URL(originHeader).origin === new URL(expected).origin;
    } catch {
      return false;
    }
  }

  /** Double-submit token check, constant-time. */
  csrfMatches(request: IncomingMessage, submitted: string | undefined): boolean {
    if (submitted === undefined || submitted === '') return false;
    const cookie = this.csrfCookie(request);
    if (cookie === undefined) return false;
    return safeEqual(cookie, submitted);
  }

  verifyStateChange(request: IncomingMessage, submitted: string | undefined): { ok: true } | { ok: false; reason: string } {
    if (!this.originAllowed(request)) return { ok: false, reason: 'cross-site request rejected' };
    if (!this.csrfMatches(request, submitted)) return { ok: false, reason: 'missing or invalid CSRF token' };
    return { ok: true };
  }

  /** Best-effort cleanup of a device's sessions when it is revoked. */
  revokeDeviceSessions(deviceId: string): void {
    this.db.deleteSessionsForDevice(deviceId);
  }

  logOwnerState(owner: OwnerRow | undefined): void {
    if (owner === undefined) {
      this.logger.warn('edge has no owner yet; first-run setup is required');
      return;
    }
    this.logger.info('owner configured', { owner: owner.name, hasPassword: owner.passwordHash != null });
  }

  deviceAccessAllowed(session: SessionRow | undefined, device: DeviceRow): boolean {
    if (session === undefined) return false;
    if (session.kind === 'owner') return true;
    return session.deviceId === device.id;
  }
}