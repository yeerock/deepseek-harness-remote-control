/**
 * The DSH RC edge server: HTTP routing, browser auth, device API, tunnel
 * upgrades and the `/d/<deviceId>/` proxy.
 *
 * Everything the edge renders itself is small and local; everything under
 * `/d/` is passed through opaquely to the agent.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEVICE_MOUNT_PREFIX,
  PROTOCOL_VERSION,
  assertSafeOriginPath,
  isValidDeviceId,
  parseDevicePath,
} from '@dsh-rc/protocol';
import {
  VERSION,
  clientAddress,
  createLogger,
  readFormBody,
  readJsonBody,
  requestHeader,
  requestOrigin,
  randomToken,
  sendJson,
  sha256Hex,
  type Logger,
} from '@dsh-rc/shared';
import { WebSocketServer } from 'ws';
import { AuthService } from './auth.js';
import { loadConfig, type EdgeConfig } from './config.js';
import { EdgeDatabase, type DeviceRow, type SessionRow } from './db.js';
import { DeviceService, validateRegisterBody } from './devices.js';
import { GuestConnections } from './guest-connections.js';
import { proxyDeviceHttp } from './proxy-http.js';
import { proxyDeviceWs } from './proxy-ws.js';
import { dashboardPage, guestSessionPage, inviteCreatedPage, invitePage, loginPage, pairPage, reconnectingPage, setupPage } from './pages.js';
import { SharingService, validateApprovalInput, validateInviteInput } from './sharing.js';
import { RateLimiter } from './rate-limit.js';
import { sendErrorPage, sendJsonError, sendPage } from './respond.js';
import { TunnelManager } from './tunnels.js';
import { rejectUpgrade } from './upgrade.js';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const DEVICE_ACTION_RE = /^\/v1\/devices\/([^/]+)\/(approve|revoke)$/;
const INVITES_PATH = '/v1/devices/me/invites';
const INVITE_ID_RE = /^\/v1\/devices\/me\/invites\/([^/]+)$/;
const APPROVAL_ID_RE = /^\/v1\/devices\/me\/approvals\/([^/]+)$/;
const GUESTS_PATH = '/v1/devices/me/guests';
const GUEST_ID_RE = /^\/v1\/devices\/me\/guests\/([^/]+)$/;
const INVITE_ROUTE_RE = /^\/i\/([A-Za-z0-9_-]{16,128})(?:\/(claim|status))?$/;
const OWNER_SHARING_RE = /^\/v1\/devices\/([^/]+)\/sharing$/;
const OWNER_INVITES_RE = /^\/v1\/devices\/([^/]+)\/invites$/;
const OWNER_INVITE_REVOKE_RE = /^\/v1\/devices\/([^/]+)\/invites\/([^/]+)\/revoke$/;
const OWNER_APPROVAL_RE = /^\/v1\/devices\/([^/]+)\/approvals\/([^/]+)$/;
const OWNER_GUESTS_REVOKE_ALL_RE = /^\/v1\/devices\/([^/]+)\/guests\/revoke-all$/;
const OWNER_GUEST_REVOKE_RE = /^\/v1\/devices\/([^/]+)\/guests\/([^/]+)\/revoke$/;
const TRAVERSAL_RE = /[\u0000-\u001f\u007f\\]/;
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface EdgeAddress {
  host: string;
  port: number;
  url: string;
}

export interface EdgeServerOptions {
  config: EdgeConfig;
  logger?: Logger;
}

export interface EdgeServer {
  readonly config: EdgeConfig;
  readonly db: EdgeDatabase;
  readonly edgeId: string;
  readonly startedAt: number;
  /** The one-time setup code, present only while no owner exists and after this boot generated it. */
  readonly setupCode: string | undefined;
  readonly setupComplete: boolean;
  /** Public-facing origin: --public-url, or the listening address for loopback demos. */
  readonly origin: string;
  readonly address: EdgeAddress | undefined;
  listen(): Promise<EdgeAddress>;
  close(): Promise<void>;
}

/** Path safety beyond URL normalisation: reject encoded traversal and absolute forms. */
function hasEncodedTraversal(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  if (decoded.startsWith('//') || TRAVERSAL_RE.test(decoded)) return true;
  for (const segment of decoded.split('/')) if (segment === '..') return true;
  return false;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = requestHeader(request, 'authorization');
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return undefined;
  const token = match[1]?.trim() ?? '';
  return token === '' ? undefined : token;
}

function wantsJson(request: IncomingMessage): boolean {
  const accept = requestHeader(request, 'accept') ?? '';
  const contentType = requestHeader(request, 'content-type') ?? '';
  return accept.includes('application/json') || contentType.includes('application/json');
}

function isFormRequest(request: IncomingMessage): boolean {
  return (requestHeader(request, 'content-type') ?? '').includes(FORM_CONTENT_TYPE);
}

function safeNextPath(value: string | null | undefined): string {
  if (value === undefined || value === null || value === '') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

function metaFor(request: IncomingMessage, config: EdgeConfig, actor: string | null) {
  return { ip: clientAddress(request, config.trustProxy), actor };
}

function displayHost(address: AddressInfo): string {
  if (address.address === '0.0.0.0') return '127.0.0.1';
  if (address.address === '::') return '[::1]';
  return address.family === 'IPv6' ? `[${address.address}]` : address.address;
}

export function createEdgeServer(options: EdgeServerOptions): EdgeServer {
  const config = options.config;
  const logger = options.logger ?? createLogger('edge', config.logLevel);
  const db = new EdgeDatabase(config.dataDir);
  const auth = new AuthService(config, db, logger);
  const devices = new DeviceService(config, db, logger);
  const embedTickets = new Map<string, { deviceId: string; expiresAt: number }>();
  if (config.autoApproveDevices) devices.approveAllPending({ ip: null, actor: 'auto-approve' });
  const sharing = new SharingService(db, logger);
  const guestConnections = new GuestConnections(db, logger);
  const tunnels = new TunnelManager(config, db, devices, logger, auth.edgeId);
  const browserWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const limiter = new RateLimiter();
  const startedAt = Date.now();

  // Audit retention: prune on boot and once a day. 0 disables pruning.
  const pruneAudit = (): void => {
    if (config.auditRetentionDays <= 0) return;
    const cutoff = Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000;
    const removed = db.pruneAudit(cutoff);
    if (removed > 0) logger.info('pruned old audit rows', { removed, retentionDays: config.auditRetentionDays });
  };
  pruneAudit();
  const auditPruneTimer = setInterval(pruneAudit, AUDIT_PRUNE_INTERVAL_MS);
  auditPruneTimer.unref?.();

  let server: Server | undefined;
  let listening = false;
  let address: EdgeAddress | undefined;

  const publicOrigin = (request: IncomingMessage): string => requestOrigin(request, config.publicUrl, config.trustProxy);

  const rateLimited = (response: ServerResponse, key: string, rule: { limit: number; windowMs: number }, json: boolean): boolean => {
    const result = limiter.check(key, rule.limit, rule.windowMs);
    if (result.ok) return false;
    const headers = { 'retry-after': String(result.retryAfterSeconds) };
    if (json) {
      response.writeHead(429, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'RATE_LIMITED', retryAfterSeconds: result.retryAfterSeconds }));
    } else {
      sendErrorPage(response, 429, 'Too many requests', 'Slow down and try again in a moment.', headers);
    }
    return true;
  };

  const ownerSession = (request: IncomingMessage) => {
    const session = auth.readSession(request);
    return session?.kind === 'owner' ? session : undefined;
  };

  async function submittedCsrf(request: IncomingMessage): Promise<string | undefined> {
    const header = requestHeader(request, 'x-csrf-token');
    if (header !== undefined && header !== '') return header;
    if (!isFormRequest(request)) return undefined;
    const form = await readFormBody(request);
    return form?.get('csrf') ?? undefined;
  }

  /* ------------------------------- routes ------------------------------- */

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://edge.local');
    const pathname = url.pathname;
    const method = (request.method ?? 'GET').toUpperCase();
    const origin = publicOrigin(request);

    // Guest sessions are deliberately tiny in scope: their own device mount,
    // the guest session page and the public invite flow. Everything else —
    // dashboard, device API, setup/pair/login, owner actions — is 403.
    const primarySession = auth.readSession(request);
    const guestSession = primarySession === undefined
      ? auth.readGuestSession(request)
      : primarySession.kind === 'guest'
        ? primarySession
        : undefined;
    if (guestSession !== undefined) {
      const allowed = pathname === '/healthz'
        || pathname === '/favicon.ico'
        || pathname === '/i/session'
        || pathname === '/i/session/disconnect'
        || pathname.startsWith('/i/')
        || pathname.startsWith('/d/');
      if (!allowed) {
        if (pathname.startsWith('/v1/')) return sendJsonError(response, 403, 'FORBIDDEN', 'guest sessions are device-scoped');
        return sendErrorPage(response, 403, 'Guest session', 'This session can only open its shared device.');
      }
    }

    if (pathname === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(response, ['GET', 'HEAD']);
      sendJson(response, 200, {
        ok: true,
        status: 'ok',
        version: VERSION,
        uptimeMs: Date.now() - startedAt,
        setupComplete: auth.setupComplete,
      });
      return;
    }

    if (pathname === '/v1/edge') {
      if (method !== 'GET') return methodNotAllowed(response, ['GET']);
      sendJson(response, 200, {
        name: 'dsh-rc-edge',
        edgeId: auth.edgeId,
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        publicUrl: origin,
        uptimeMs: Date.now() - startedAt,
        presenceGraceMs: config.presenceGraceMs,
        auditRetentionDays: config.auditRetentionDays,
        setupComplete: auth.setupComplete,
        devices: db.countDevices(),
        tunnels: tunnels.size,
      });
      return;
    }

    if (pathname === '/v1/devices/register') {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      await handleRegister(request, response);
      return;
    }

    if (pathname === '/v1/devices/me') {
      if (method !== 'GET') return methodNotAllowed(response, ['GET']);
      handleDeviceMe(request, response);
      return;
    }

    if (pathname === '/v1/devices/me/embed-ticket') {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleEmbedTicket(request, response);
    }

    if (pathname.startsWith('/embed/')) {
      if (method !== 'GET') return methodNotAllowed(response, ['GET']);
      return handleEmbedOpen(request, response, pathname.slice('/embed/'.length));
    }

    if (pathname === '/v1/devices/me/peers') {
      if (method !== 'GET') return methodNotAllowed(response, ['GET']);
      return handleDevicePeers(request, response);
    }

    if (pathname === '/v1/devices/me/sharing') {
      if (method === 'GET') return handleSharingGet(request, response);
      if (method === 'PUT') return handleSharingPut(request, response);
      return methodNotAllowed(response, ['GET', 'PUT']);
    }

    if (pathname === INVITES_PATH) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleInviteCreate(request, response);
    }

    const inviteMatch = INVITE_ID_RE.exec(pathname);
    if (inviteMatch !== null) {
      if (method !== 'DELETE') return methodNotAllowed(response, ['DELETE']);
      return handleInviteDelete(request, response, inviteMatch[1] ?? '');
    }

    const approvalMatch = APPROVAL_ID_RE.exec(pathname);
    if (approvalMatch !== null) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleApprovalDecision(request, response, approvalMatch[1] ?? '');
    }

    if (pathname === GUESTS_PATH) {
      if (method !== 'DELETE') return methodNotAllowed(response, ['DELETE']);
      return handleRevokeAllGuests(request, response);
    }

    const guestMatch = GUEST_ID_RE.exec(pathname);
    if (guestMatch !== null) {
      if (method !== 'DELETE') return methodNotAllowed(response, ['DELETE']);
      return handleRevokeGuest(request, response, guestMatch[1] ?? '');
    }

    const ownerSharing = OWNER_SHARING_RE.exec(pathname);
    if (ownerSharing !== null) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleOwnerSharingToggle(request, response, ownerSharing[1] ?? '');
    }

    const ownerInvites = OWNER_INVITES_RE.exec(pathname);
    if (ownerInvites !== null) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleOwnerInviteCreate(request, response, ownerInvites[1] ?? '');
    }

    const ownerInviteRevoke = OWNER_INVITE_REVOKE_RE.exec(pathname);
    if (ownerInviteRevoke !== null) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleOwnerInviteRevoke(request, response, ownerInviteRevoke[1] ?? '', ownerInviteRevoke[2] ?? '');
    }

    const ownerApproval = OWNER_APPROVAL_RE.exec(pathname);
    if (ownerApproval !== null) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleOwnerApproval(request, response, ownerApproval[1] ?? '', ownerApproval[2] ?? '');
    }

    const ownerGuestsRevokeAll = OWNER_GUESTS_REVOKE_ALL_RE.exec(pathname);
    if (ownerGuestsRevokeAll !== null) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleOwnerGuestsRevokeAll(request, response, ownerGuestsRevokeAll[1] ?? '');
    }

    const ownerGuestRevoke = OWNER_GUEST_REVOKE_RE.exec(pathname);
    if (ownerGuestRevoke !== null) {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleOwnerGuestRevoke(request, response, ownerGuestRevoke[1] ?? '', ownerGuestRevoke[2] ?? '');
    }

    const deviceAction = DEVICE_ACTION_RE.exec(pathname);
    if (deviceAction !== null) {
      const deviceId = deviceAction[1] ?? '';
      const action = deviceAction[2] ?? '';
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      if (!isValidDeviceId(deviceId)) return sendJsonError(response, 404, 'NOT_FOUND');
      await handleDeviceAction(request, response, deviceId, action === 'approve' ? 'approve' : 'revoke');
      return;
    }

    if (pathname === '/setup') {
      if (method === 'GET') {
        if (auth.setupComplete) {
          return sendErrorPage(response, 403, 'Already configured', 'This edge already has an owner. Sign in instead.');
        }
        const csrf = auth.ensureCsrf(request, response);
        return sendPage(response, 200, setupPage({ csrf, ...(url.searchParams.get('code') === null ? {} : { code: url.searchParams.get('code') ?? '' }) }));
      }
      if (method === 'POST') return handleSetup(request, response);
      return methodNotAllowed(response, ['GET', 'POST']);
    }

    if (pathname === '/login') {
      if (method === 'GET') {
        if (!auth.setupComplete) return redirect(response, 303, '/setup');
        const csrf = auth.ensureCsrf(request, response);
        return sendPage(response, 200, loginPage({ csrf, hasPassword: auth.hasOwnerPassword(), next: safeNextPath(url.searchParams.get('next')) }));
      }
      if (method === 'POST') return handleLogin(request, response);
      return methodNotAllowed(response, ['GET', 'POST']);
    }

    if (pathname === '/logout') {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleLogout(request, response);
    }

    if (pathname === '/i/session') {
      if (method !== 'GET') return methodNotAllowed(response, ['GET']);
      return handleGuestSessionPage(request, response);
    }

    if (pathname === '/i/session/disconnect') {
      if (method !== 'POST') return methodNotAllowed(response, ['POST']);
      return handleGuestDisconnect(request, response);
    }

    const inviteRoute = INVITE_ROUTE_RE.exec(pathname);
    if (inviteRoute !== null) {
      const token = inviteRoute[1] ?? '';
      const action = inviteRoute[2];
      if (action === undefined) {
        if (method !== 'GET') return methodNotAllowed(response, ['GET']);
        return handleInvitePage(request, response, token);
      }
      if (action === 'claim') {
        if (method !== 'POST') return methodNotAllowed(response, ['POST']);
        return handleInviteClaim(request, response, token);
      }
      if (method !== 'GET') return methodNotAllowed(response, ['GET']);
      return handleInviteStatus(request, response, token);
    }

    if (pathname === '/pair') {
      if (method === 'GET') {
        const csrf = auth.ensureCsrf(request, response);
        const code = url.searchParams.get('code') ?? undefined;
        const session = auth.readSession(request);
        return sendPage(
          response,
          200,
          pairPage({ csrf, ...(code === undefined ? {} : { code }), requiresPassword: session?.kind !== 'owner' }),
        );
      }
      if (method === 'POST') return handlePair(request, response);
      return methodNotAllowed(response, ['GET', 'POST']);
    }

    if (pathname === '/') {
      if (method !== 'GET') return methodNotAllowed(response, ['GET']);
      return handleDashboard(request, response);
    }

    if (pathname === '/favicon.ico') {
      response.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      response.end();
      return;
    }

    if (pathname === '/d' || pathname.startsWith(DEVICE_MOUNT_PREFIX)) {
      await handleDeviceHttp(request, response, pathname, url.search);
      return;
    }

    if (pathname.startsWith('/v1/')) return sendJsonError(response, 404, 'NOT_FOUND');
    return sendErrorPage(response, 404, 'Not found', 'No such page on this edge.');
  }

  function methodNotAllowed(response: ServerResponse, allowed: string[]): void {
    sendJsonError(response, 405, 'METHOD_NOT_ALLOWED', `allowed: ${allowed.join(', ')}`);
  }

  function redirect(response: ServerResponse, status: 302 | 303 | 307 | 308, location: string): void {
    response.writeHead(status, { location, 'cache-control': 'no-store', 'content-length': '0' });
    response.end();
  }

  /* ------------------------------ registration ----------------------------- */

  async function handleRegister(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = clientAddress(request, config.trustProxy);
    if (rateLimited(response, `register:${ip}`, config.rateLimits.register, true)) return;
    const body = await readJsonBody(request, 16 * 1024);
    if (body === undefined) return sendJsonError(response, 400, 'BAD_REQUEST', 'expected a JSON object');
    const validated = validateRegisterBody(body);
    if (!validated.ok) return sendJsonError(response, 400, 'BAD_REQUEST', validated.error);
    const registered = devices.register(validated.value, metaFor(request, config, 'agent'));
    const pairUrl = `${publicOrigin(request)}/pair?code=${encodeURIComponent(registered.pairCode)}`;
    sendJson(response, 201, {
      deviceId: registered.device.id,
      deviceSecret: registered.deviceSecret,
      pairCode: registered.pairCode,
      pairUrl,
      status: registered.device.status,
    });
  }

  async function handleEmbedTicket(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearerToken(request);
    if (token === undefined) return sendJsonError(response, 401, 'AUTH_FAILED', 'missing bearer device secret');
    const caller = devices.findBySecret(token);
    if (caller === undefined) return sendJsonError(response, 401, 'AUTH_FAILED', 'unknown device secret');
    if (caller.status !== 'approved') return sendJsonError(response, 403, 'DEVICE_NOT_APPROVED', 'this device is not approved');
    const body = await readJsonBody(request, 4 * 1024);
    const targetId = typeof body === 'object' && body !== null && !Array.isArray(body) && typeof (body as Record<string, unknown>)['deviceId'] === 'string' ? String((body as Record<string, unknown>)['deviceId']) : '';
    if (targetId === '') return sendJsonError(response, 400, 'BAD_REQUEST', 'deviceId is required');
    const target = devices.findById(targetId);
    if (target === undefined || target.status !== 'approved') return sendJsonError(response, 404, 'NOT_FOUND', 'approved Harness not found');
    const ticket = randomToken(24);
    embedTickets.set(ticket, { deviceId: targetId, expiresAt: Date.now() + 60_000 });
    sendJson(response, 200, { url: `${publicOrigin(request)}/embed/${encodeURIComponent(ticket)}` });
  }

  function handleEmbedOpen(request: IncomingMessage, response: ServerResponse, ticket: string): Promise<void> | void {
    const entry = embedTickets.get(ticket);
    embedTickets.delete(ticket);
    if (entry === undefined || entry.expiresAt <= Date.now()) return sendErrorPage(response, 401, 'Embed link expired', 'Open the Harness again from Remote Workspaces.');
    const now = Date.now();
    const session = db.createSession({
      kind: 'owner',
      deviceId: null,
      csrfToken: randomToken(24),
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      ip: clientAddress(request, config.trustProxy),
      userAgent: request.headers['user-agent'] ?? null,
    });
    auth.setEmbedDeviceCookie(request, response, session);
    const query = new URL(request.url ?? '/', 'http://dsh.internal').search;
    response.writeHead(303, { location: `/d/${encodeURIComponent(entry.deviceId)}/${query}`, 'cache-control': 'no-store', 'content-length': '0' });
    response.end();
  }

  function handleDevicePeers(request: IncomingMessage, response: ServerResponse): void {
    const token = bearerToken(request);
    if (token === undefined) return sendJsonError(response, 401, 'AUTH_FAILED', 'missing bearer device secret');
    const device = devices.findBySecret(token);
    if (device === undefined) return sendJsonError(response, 401, 'AUTH_FAILED', 'unknown device secret');
    if (device.status !== 'approved') return sendJsonError(response, 403, 'DEVICE_NOT_APPROVED', 'this device is not approved');
    const peers = devices.listPeers(device.id).map((peer) => ({
      id: peer.id,
      name: peer.name,
      platform: peer.platform,
      online: tunnels.isOnline(peer.id),
      lastSeenAt: peer.lastSeenAt,
    }));
    sendJson(response, 200, { peers, publicUrl: config.publicUrl });
  }

  function handleDeviceMe(request: IncomingMessage, response: ServerResponse): void {
    const token = bearerToken(request);
    if (token === undefined) return sendJsonError(response, 401, 'AUTH_FAILED', 'missing bearer device secret');
    const device = devices.findBySecret(token);
    if (device === undefined) return sendJsonError(response, 401, 'AUTH_FAILED', 'unknown device secret');
    if (device.status === 'revoked') return sendJsonError(response, 403, 'DEVICE_REVOKED', 'this device was revoked by the owner');
    sendJson(response, 200, devices.publicDevice(device, tunnels.isOnline(device.id)));
  }

  async function handleDeviceAction(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string,
    action: 'approve' | 'revoke',
  ): Promise<void> {
    const json = wantsJson(request);
    const session = ownerSession(request);
    if (session === undefined) {
      if (json) return sendJsonError(response, 401, 'UNAUTHORIZED', 'owner session required');
      return redirect(response, 303, '/login');
    }
    const submitted = await submittedCsrf(request);
    const check = auth.verifyStateChange(request, submitted);
    if (!check.ok) {
      if (json) return sendJsonError(response, 403, 'CSRF_FAILED', check.reason);
      return sendErrorPage(response, 403, 'Request rejected', check.reason);
    }
    const device = db.getDevice(deviceId);
    if (device === undefined) {
      if (json) return sendJsonError(response, 404, 'NOT_FOUND', 'unknown device');
      return sendErrorPage(response, 404, 'Unknown device', 'That device does not exist on this edge.');
    }
    const meta = metaFor(request, config, 'owner');
    let updated: DeviceRow | undefined;
    if (action === 'approve') {
      updated = devices.approve(deviceId, meta);
    } else {
      const shared = sharing.revokeForDevice(deviceId, meta);
      updated = devices.revoke(deviceId, meta);
      tunnels.closeDevice(deviceId, 4003, 'DEVICE_REVOKED');
      auth.revokeDeviceSessions(deviceId);
      guestConnections.closeMany(shared.sessionIds, 'device revoked');
    }
    if (updated === undefined) return sendJsonError(response, 404, 'NOT_FOUND', 'unknown device');
    if (json) {
      sendJson(response, 200, { ok: true, device: devices.publicDevice(updated, tunnels.isOnline(updated.id)) });
      return;
    }
    redirect(response, 303, '/');
  }

  /* -------------------------------- setup -------------------------------- */

  async function handleSetup(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = clientAddress(request, config.trustProxy);
    if (rateLimited(response, `setup:${ip}`, config.rateLimits.setup, false)) return;
    if (auth.setupComplete) return sendErrorPage(response, 403, 'Already configured', 'This edge already has an owner.');
    const form = await readFormBody(request);
    if (form === undefined) return sendErrorPage(response, 400, 'Bad request', 'expected a form submission');
    const check = auth.verifyStateChange(request, form.get('csrf') ?? undefined);
    if (!check.ok) return sendErrorPage(response, 403, 'Request rejected', check.reason);
    const code = form.get('code') ?? '';
    const passwordRaw = form.get('password') ?? '';
    const password = passwordRaw === '' ? null : passwordRaw;
    if (password !== null && (password.length < 8 || password.length > 256)) {
      const csrf = auth.ensureCsrf(request, response);
      return sendPage(response, 400, setupPage({ csrf, code, error: 'The owner password must be 8-256 characters.' }));
    }
    if (!auth.verifySetupCode(code)) {
      const csrf = auth.ensureCsrf(request, response);
      return sendPage(response, 403, setupPage({ csrf, code, error: 'That setup code is not valid or has expired.' }));
    }
    const meta = { ip, userAgent: requestHeader(request, 'user-agent') ?? null, now: Date.now() };
    const created = auth.completeSetup('owner', password, meta);
    auth.setSessionCookie(request, response, created.session);
    db.addAudit({ event: 'owner-setup', actor: 'owner', ip, detail: 'owner session created', ts: meta.now });
    logger.info('owner configured', { ip });
    limiter.reset(`setup:${ip}`);
    redirect(response, 303, '/');
  }

  async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = clientAddress(request, config.trustProxy);
    if (rateLimited(response, `login:${ip}`, config.rateLimits.login, false)) return;
    if (!auth.setupComplete) return redirect(response, 303, '/setup');
    const form = await readFormBody(request);
    if (form === undefined) return sendErrorPage(response, 400, 'Bad request', 'expected a form submission');
    const check = auth.verifyStateChange(request, form.get('csrf') ?? undefined);
    if (!check.ok) return sendErrorPage(response, 403, 'Request rejected', check.reason);
    const password = form.get('password') ?? '';
    const next = safeNextPath(form.get('next'));
    if (!auth.hasOwnerPassword()) {
      const csrf = auth.ensureCsrf(request, response);
      return sendPage(response, 403, loginPage({ csrf, hasPassword: false, next }));
    }
    if (!auth.verifyOwnerPassword(password)) {
      const csrf = auth.ensureCsrf(request, response);
      return sendPage(response, 403, loginPage({ csrf, hasPassword: true, error: 'Incorrect password.', next }));
    }
    const session = auth.createSession('owner', null, {
      ip,
      userAgent: requestHeader(request, 'user-agent') ?? null,
      now: Date.now(),
    });
    auth.setSessionCookie(request, response, session);
    db.addAudit({ event: 'login', actor: 'owner', ip, ts: Date.now() });
    limiter.reset(`login:${ip}`);
    redirect(response, 303, next);
  }

  async function handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = auth.readSession(request);
    const submitted = await submittedCsrf(request);
    const check = auth.verifyStateChange(request, submitted);
    if (!check.ok) return sendErrorPage(response, 403, 'Request rejected', check.reason);
    if (session !== undefined) {
      db.deleteSession(session.id);
      db.addAudit({ event: 'logout', actor: session.kind, deviceId: session.deviceId, ts: Date.now() });
    }
    auth.clearSessionCookie(request, response);
    redirect(response, 303, '/login');
  }

  /* --------------------------------- pair --------------------------------- */

  async function handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = clientAddress(request, config.trustProxy);
    if (rateLimited(response, `pair:${ip}`, config.rateLimits.pair, false)) return;
    const form = await readFormBody(request);
    if (form === undefined) return sendErrorPage(response, 400, 'Bad request', 'expected a form submission');
    const check = auth.verifyStateChange(request, form.get('csrf') ?? undefined);
    if (!check.ok) return sendErrorPage(response, 403, 'Request rejected', check.reason);
    const code = form.get('code') ?? '';

    // A pair code is proof of proximity, not a login. Redeeming it requires an
    // owner session, or the owner password in the same submission.
    const session = auth.readSession(request);
    const isOwner = session?.kind === 'owner';
    if (!isOwner) {
      const password = form.get('password') ?? '';
      const csrf = auth.ensureCsrf(request, response);
      if (!auth.hasOwnerPassword()) {
        return sendPage(
          response,
          401,
          pairPage({ csrf, code, requiresPassword: true, error: 'This edge has no owner password configured. Sign in as the owner instead.' }),
        );
      }
      if (!auth.verifyOwnerPassword(password)) {
        return sendPage(
          response,
          401,
          pairPage({ csrf, code, requiresPassword: true, error: 'The owner password is incorrect. The device was not approved.' }),
        );
      }
    }

    const result = devices.redeemPairCode(code, metaFor(request, config, 'owner'));
    if (!result.ok) {
      const csrf = auth.ensureCsrf(request, response);
      return sendPage(response, 403, pairPage({ csrf, code, requiresPassword: !isOwner, error: result.reason }));
    }
    if (!isOwner) {
      const created = auth.createSession('device', result.device.id, {
        ip,
        userAgent: requestHeader(request, 'user-agent') ?? null,
        now: Date.now(),
      });
      auth.setSessionCookie(request, response, created);
    }
    limiter.reset(`pair:${ip}`);
    redirect(response, 303, `/d/${result.device.id}/`);
  }

  /* -------------------------------- sharing ------------------------------ */

  function sharingMeta(request: IncomingMessage, actor: string) {
    return {
      ip: clientAddress(request, config.trustProxy),
      userAgent: requestHeader(request, 'user-agent') ?? null,
      actor,
    };
  }

  /** Device-scoped sharing API: Bearer device secret, approved devices only. */
  function authorizedDevice(request: IncomingMessage, response: ServerResponse): DeviceRow | undefined {
    const token = bearerToken(request);
    if (token === undefined) {
      sendJsonError(response, 401, 'AUTH_FAILED', 'missing bearer device secret');
      return undefined;
    }
    const device = devices.findBySecret(token);
    if (device === undefined) {
      sendJsonError(response, 401, 'AUTH_FAILED', 'unknown device secret');
      return undefined;
    }
    if (device.status === 'revoked') {
      sendJsonError(response, 403, 'DEVICE_REVOKED', 'this device was revoked by the owner');
      return undefined;
    }
    if (device.status !== 'approved') {
      sendJsonError(response, 403, 'DEVICE_PENDING', 'this device has not been approved yet');
      return undefined;
    }
    return device;
  }

  function sharingPublicUrl(request: IncomingMessage): string {
    return (config.publicUrl !== '' ? config.publicUrl : publicOrigin(request)).replace(/\/+$/, '');
  }

  function handleSharingGet(request: IncomingMessage, response: ServerResponse): void {
    const device = authorizedDevice(request, response);
    if (device === undefined) return;
    sendJson(response, 200, sharing.summary(device, sharingPublicUrl(request)));
  }

  async function handleSharingPut(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const device = authorizedDevice(request, response);
    if (device === undefined) return;
    const body = await readJsonBody(request, 16 * 1024);
    if (typeof body !== 'object' || body === null || typeof (body as Record<string, unknown>)['enabled'] !== 'boolean') {
      return sendJsonError(response, 400, 'BAD_REQUEST', 'expected {"enabled": true|false}');
    }
    const enabled = (body as Record<string, unknown>)['enabled'] === true;
    const result = sharing.setEnabled(device, enabled, sharingMeta(request, 'agent'));
    if (!result.enabled) guestConnections.closeMany(result.sessionIds, 'sharing disabled');
    sendJson(response, 200, { enabled: result.enabled });
  }

  async function handleInviteCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const device = authorizedDevice(request, response);
    if (device === undefined) return;
    if (rateLimited(response, `sharing-invite:${device.id}`, config.rateLimits.sharingInvite, true)) return;
    const body = await readJsonBody(request, 16 * 1024);
    if (body === undefined) return sendJsonError(response, 400, 'BAD_REQUEST', 'expected a JSON object');
    const validated = validateInviteInput(body);
    if (!validated.ok) return sendJsonError(response, 400, 'BAD_REQUEST', validated.error);
    try {
      const created = sharing.createInvite(device, validated.value, sharingMeta(request, 'agent'), sharingPublicUrl(request));
      sendJson(response, 200, {
        id: created.invite.id,
        url: created.url,
        token: created.token,
        expiresAt: created.invite.expiresAt,
      });
    } catch (error) {
      const status = typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409 ? 409 : 500;
      if (status === 409) return sendJsonError(response, 409, 'SHARING_DISABLED', 'enable sharing before creating an invite');
      logger.warn('invite creation failed', { deviceId: device.id, error });
      sendJsonError(response, 500, 'INVITE_FAILED');
    }
  }

  async function handleInviteDelete(request: IncomingMessage, response: ServerResponse, inviteId: string): Promise<void> {
    const device = authorizedDevice(request, response);
    if (device === undefined) return;
    const result = sharing.deleteInvite(device.id, inviteId, sharingMeta(request, 'agent'));
    if (!result.ok) return sendJsonError(response, 404, 'NOT_FOUND', 'unknown invite');
    sendJson(response, 200, { ok: true });
  }

  async function handleApprovalDecision(request: IncomingMessage, response: ServerResponse, approvalId: string): Promise<void> {
    const device = authorizedDevice(request, response);
    if (device === undefined) return;
    if (rateLimited(response, `sharing-approval:${device.id}`, config.rateLimits.sharingApproval, true)) return;
    const body = await readJsonBody(request, 16 * 1024);
    if (body === undefined) return sendJsonError(response, 400, 'BAD_REQUEST', 'expected a JSON object');
    const validated = validateApprovalInput(body);
    if (!validated.ok) return sendJsonError(response, 400, 'BAD_REQUEST', validated.error);
    const result = sharing.decideApproval(device.id, approvalId, validated.decision, sharingMeta(request, 'agent'));
    if (!result.ok) {
      if (result.status === 404) return sendJsonError(response, 404, result.error);
      if (result.status === 409) return sendJsonError(response, 409, result.error);
      return sendJsonError(response, 500, result.error);
    }
    sendJson(response, 200, result.sessionId === undefined ? { ok: true } : { ok: true, sessionId: result.sessionId });
  }

  async function handleRevokeGuest(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
    const device = authorizedDevice(request, response);
    if (device === undefined) return;
    const ok = sharing.revokeGuest(device.id, sessionId, sharingMeta(request, 'agent'));
    if (!ok) return sendJsonError(response, 404, 'NOT_FOUND', 'unknown guest session');
    guestConnections.closeSession(sessionId, 'guest session revoked');
    sendJson(response, 200, { ok: true });
  }

  async function handleRevokeAllGuests(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const device = authorizedDevice(request, response);
    if (device === undefined) return;
    const result = sharing.revokeAllGuests(device.id, sharingMeta(request, 'agent'));
    guestConnections.closeMany(result.sessionIds, 'guest session revoked');
    sendJson(response, 200, { revoked: result.revoked });
  }

  /* --------------------------- owner dashboard forms ---------------------- */

  async function ownerFormContext(request: IncomingMessage, response: ServerResponse): Promise<URLSearchParams | undefined> {
    const session = ownerSession(request);
    if (session === undefined) {
      redirect(response, 303, '/login');
      return undefined;
    }
    const form = await readFormBody(request);
    if (form === undefined) {
      sendErrorPage(response, 400, 'Bad request', 'expected a form submission');
      return undefined;
    }
    const check = auth.verifyStateChange(request, form.get('csrf') ?? undefined);
    if (!check.ok) {
      sendErrorPage(response, 403, 'Request rejected', check.reason);
      return undefined;
    }
    return form;
  }

  function ownerDeviceFor(deviceId: string, response: ServerResponse): DeviceRow | undefined {
    if (!isValidDeviceId(deviceId)) {
      sendErrorPage(response, 404, 'Unknown device', 'That device does not exist on this edge.');
      return undefined;
    }
    const device = db.getDevice(deviceId);
    if (device === undefined) {
      sendErrorPage(response, 404, 'Unknown device', 'That device does not exist on this edge.');
      return undefined;
    }
    if (device.status !== 'approved') {
      sendErrorPage(response, 400, 'Device not approved', 'Approve this device before sharing it.');
      return undefined;
    }
    return device;
  }

  async function handleOwnerSharingToggle(request: IncomingMessage, response: ServerResponse, deviceId: string): Promise<void> {
    const form = await ownerFormContext(request, response);
    if (form === undefined) return;
    const device = ownerDeviceFor(deviceId, response);
    if (device === undefined) return;
    const enabled = form.get('enabled') === '1';
    const result = sharing.setEnabled(device, enabled, sharingMeta(request, 'owner'));
    if (!result.enabled) guestConnections.closeMany(result.sessionIds, 'sharing disabled');
    redirect(response, 303, '/');
  }

  async function handleOwnerInviteCreate(request: IncomingMessage, response: ServerResponse, deviceId: string): Promise<void> {
    const form = await ownerFormContext(request, response);
    if (form === undefined) return;
    const device = ownerDeviceFor(deviceId, response);
    if (device === undefined) return;
    if (!device.sharingEnabled) {
      sendErrorPage(response, 409, 'Sharing is off', 'Turn on "Share this Harness" before creating an invite.');
      return;
    }
    if (rateLimited(response, `sharing-invite:${device.id}`, config.rateLimits.sharingInvite, false)) return;
    const body: Record<string, unknown> = {
      label: form.get('label') ?? 'Guest',
      ttlSeconds: Number(form.get('ttlSeconds') ?? '3600'),
      maxUses: Number(form.get('maxUses') ?? '1'),
    };
    const validated = validateInviteInput(body);
    if (!validated.ok) {
      sendErrorPage(response, 400, 'Invite not created', validated.error);
      return;
    }
    try {
      const created = sharing.createInvite(device, validated.value, sharingMeta(request, 'owner'), sharingPublicUrl(request));
      sendPage(response, 200, inviteCreatedPage({
        deviceName: device.name,
        label: created.invite.label,
        url: created.url,
        expiresAt: created.invite.expiresAt,
      }));
    } catch (error) {
      logger.warn('owner invite creation failed', { deviceId: device.id, error });
      sendErrorPage(response, 409, 'Invite not created', 'Sharing is disabled for this device.');
    }
  }

  async function handleOwnerInviteRevoke(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string,
    inviteId: string,
  ): Promise<void> {
    const form = await ownerFormContext(request, response);
    if (form === undefined) return;
    const device = ownerDeviceFor(deviceId, response);
    if (device === undefined) return;
    const result = sharing.deleteInvite(device.id, inviteId, sharingMeta(request, 'owner'));
    if (!result.ok) {
      sendErrorPage(response, 404, 'Unknown invite', 'That invite does not exist for this device.');
      return;
    }
    redirect(response, 303, '/');
  }

  async function handleOwnerApproval(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string,
    approvalId: string,
  ): Promise<void> {
    const form = await ownerFormContext(request, response);
    if (form === undefined) return;
    const device = ownerDeviceFor(deviceId, response);
    if (device === undefined) return;
    const raw = form.get('decision');
    if (raw !== 'approve' && raw !== 'deny') {
      sendErrorPage(response, 400, 'Bad request', 'decision must be approve or deny');
      return;
    }
    const result = sharing.decideApproval(device.id, approvalId, raw, sharingMeta(request, 'owner'));
    if (!result.ok) {
      sendErrorPage(response, 409, 'Approval failed', result.error);
      return;
    }
    redirect(response, 303, '/');
  }

  async function handleOwnerGuestRevoke(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string,
    sessionId: string,
  ): Promise<void> {
    const form = await ownerFormContext(request, response);
    if (form === undefined) return;
    const device = ownerDeviceFor(deviceId, response);
    if (device === undefined) return;
    if (!sharing.revokeGuest(device.id, sessionId, sharingMeta(request, 'owner'))) {
      sendErrorPage(response, 404, 'Unknown guest', 'That guest session does not exist for this device.');
      return;
    }
    guestConnections.closeSession(sessionId, 'guest session revoked');
    redirect(response, 303, '/');
  }

  async function handleOwnerGuestsRevokeAll(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string,
  ): Promise<void> {
    const form = await ownerFormContext(request, response);
    if (form === undefined) return;
    const device = ownerDeviceFor(deviceId, response);
    if (device === undefined) return;
    const result = sharing.revokeAllGuests(device.id, sharingMeta(request, 'owner'));
    guestConnections.closeMany(result.sessionIds, 'guest session revoked');
    redirect(response, 303, '/');
  }

  /* ------------------------------ guest invites --------------------------- */

  function inviteLookup(token: string): { invite: ReturnType<EdgeDatabase['getInvite']>; device: DeviceRow | undefined } {
    const invite = db.getInviteByTokenHash(sha256Hex(token));
    const device = invite === undefined ? undefined : db.getDevice(invite.deviceId);
    return { invite, device };
  }

  function inviteUnavailableReason(invite: NonNullable<ReturnType<EdgeDatabase['getInvite']>>, device: DeviceRow | undefined, now: number): string | undefined {
    if (invite.revokedAt !== null) return 'This invite was revoked by the host.';
    if (invite.expiresAt !== 0 && invite.expiresAt <= now) return 'This invite has expired.';
    if (invite.uses >= invite.maxUses) return 'This invite has already been used.';
    if (device === undefined || device.status !== 'approved' || !device.sharingEnabled) {
      return 'This device is not accepting guest sessions.';
    }
    return undefined;
  }

  function handleInvitePage(request: IncomingMessage, response: ServerResponse, token: string): void {
    const { invite, device } = inviteLookup(token);
    if (invite === undefined || device === undefined) {
      sendErrorPage(response, 404, 'Invite not found', 'This invite link is not valid.');
      return;
    }
    // A browser that already claimed this invite must keep seeing the waiting
    // page even though the invite itself is now consumed. Check the claim
    // cookie before the invite-availability guard.
    const claim = auth.readClaim(request);
    let pending = false;
    if (claim !== undefined) {
      const approval = sharing.pendingApprovalForClaim(token, claim.aid);
      if (approval !== undefined) {
        const status = sharing.approvalStatus(token, claim.aid);
        if (status.status === 'pending' || status.status === 'approved') pending = true;
      }
    }
    if (!pending) {
      const reason = inviteUnavailableReason(invite, device, Date.now());
      if (reason !== undefined) {
        sendErrorPage(response, 410, 'Invite unavailable', reason);
        return;
      }
    }
    const csrf = auth.ensureCsrf(request, response);
    sendPage(response, 200, invitePage({
      csrf,
      token,
      deviceName: device.name,
      label: invite.label,
      expiresAt: invite.expiresAt,
      pending,
    }));
  }

  async function handleInviteClaim(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const ip = clientAddress(request, config.trustProxy);
    if (rateLimited(response, `sharing-claim:${ip}`, config.rateLimits.sharingClaim, false)) return;
    const form = await readFormBody(request);
    if (form === undefined) return sendErrorPage(response, 400, 'Bad request', 'expected a form submission');
    const check = auth.verifyStateChange(request, form.get('csrf') ?? undefined);
    if (!check.ok) return sendErrorPage(response, 403, 'Request rejected', check.reason);

    const existingClaim = auth.readClaim(request);
    if (existingClaim !== undefined) {
      const pending = sharing.pendingApprovalForClaim(token, existingClaim.aid);
      if (pending !== undefined) {
        const status = sharing.approvalStatus(token, existingClaim.aid);
        if (status.status === 'pending' || status.status === 'approved') {
          if (wantsJson(request)) {
            return sendJson(response, 200, { ...status, approvalId: pending.id, deviceId: pending.deviceId });
          }
          return redirect(response, 303, `/i/${token}`);
        }
      }
    }

    const result = sharing.claimInvite(token, sharingMeta(request, 'guest'));
    if (!result.ok) {
      sendErrorPage(response, result.status, result.status === 404 ? 'Invite not found' : 'Invite unavailable', result.error);
      return;
    }
    auth.setClaimCookie(request, response, result.approval.id);
    if (wantsJson(request)) {
      return sendJson(response, 200, {
        status: 'pending',
        approvalId: result.approval.id,
        deviceId: result.approval.deviceId,
      });
    }
    redirect(response, 303, `/i/${token}`);
  }

  function handleInviteStatus(request: IncomingMessage, response: ServerResponse, token: string): void {
    const claim = auth.readClaim(request);
    if (claim === undefined) return sendJson(response, 400, { status: 'unclaimed' });
    const status = sharing.approvalStatus(token, claim.aid);
    if (status.status === 'approved' && status.sessionId !== undefined && status.deviceId !== undefined) {
      const session = sharing.guestSession(status.sessionId);
      if (session !== undefined) {
        auth.setGuestSessionCookie(request, response, session);
        auth.clearClaimCookie(request, response);
        return sendJson(response, 200, {
          status: 'approved',
          deviceId: status.deviceId,
          devicePath: `/d/${status.deviceId}/`,
          sessionId: status.sessionId,
        });
      }
    }
    sendJson(response, 200, status.status === 'pending' && status.deviceId !== undefined
      ? { status: status.status, deviceId: status.deviceId }
      : { status: status.status });
  }

  function handleGuestSessionPage(request: IncomingMessage, response: ServerResponse): void {
    const guest = auth.readGuestSession(request);
    if (guest === undefined) {
      return sendErrorPage(response, 401, 'No guest session', 'Open your invite link again or ask the host for a new invite.');
    }
    const device = guest.deviceId === null ? undefined : db.getDevice(guest.deviceId);
    if (device === undefined || !auth.guestAccessAllowed(guest, device)) {
      return sendErrorPage(response, 403, 'Guest session ended', 'The host revoked this guest session or turned sharing off.');
    }
    const csrf = auth.ensureCsrf(request, response);
    sendPage(response, 200, guestSessionPage({
      csrf,
      deviceId: device.id,
      deviceName: device.name,
      label: sharing.guestSessionLabel(guest.id) ?? 'Guest',
      since: guest.createdAt,
    }));
  }

  async function handleGuestDisconnect(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const guest = auth.readGuestSession(request);
    if (guest === undefined) {
      return sendErrorPage(response, 401, 'No guest session', 'This browser is not signed in as a guest.');
    }
    const form = await readFormBody(request);
    if (form === undefined) return sendErrorPage(response, 400, 'Bad request', 'expected a form submission');
    const check = auth.verifyStateChange(request, form.get('csrf') ?? undefined);
    if (!check.ok) return sendErrorPage(response, 403, 'Request rejected', check.reason);
    const meta = sharingMeta(request, 'guest');
    if (guest.deviceId !== null) {
      const label = sharing.guestSessionLabel(guest.id) ?? 'Guest';
      sharing.revokeGuest(guest.deviceId, guest.id, meta);
      db.addAudit({
        event: 'guest-disconnected',
        deviceId: guest.deviceId,
        actor: 'guest',
        ip: meta.ip,
        detail: `${guest.id} · ${label} · self`,
        ts: Date.now(),
      });
    }
    guestConnections.closeSession(guest.id, 'guest disconnected');
    auth.clearGuestSessionCookie(request, response);
    redirect(response, 303, '/');
  }

  /* ------------------------------- dashboard ------------------------------ */

  function handleDashboard(request: IncomingMessage, response: ServerResponse): void {
    const session = auth.readSession(request);
    if (session === undefined) {
      return redirect(response, 303, auth.setupComplete ? '/login' : '/setup');
    }
    if (session.kind !== 'owner') {
      return sendErrorPage(response, 403, 'Owner access required', 'This session is paired to a single device.');
    }
    const owner = db.getOwner();
    const csrf = auth.ensureCsrf(request, response);
    const sharingUrl = config.publicUrl !== '' ? config.publicUrl : publicOrigin(request);
    const deviceRows = db.listDevices().map((device) => {
      const presence = tunnels.presence(device);
      return {
        device,
        online: presence.online,
        reconnecting: presence.reconnecting,
        sharing: sharing.summary(device, sharingUrl),
      };
    });
    sendPage(
      response,
      200,
      dashboardPage({
        ownerName: owner?.name ?? 'owner',
        csrf,
        devices: deviceRows,
        audit: db.listAudit(20),
        edgeId: auth.edgeId,
        publicOrigin: publicOrigin(request),
      }),
    );
  }

  /* ----------------------------- device proxy ---------------------------- */

  type DeviceAccess =
    | { ok: true; session: SessionRow; guest: boolean }
    | { ok: false; status: number; title: string; message: string };

  function checkDeviceAccess(request: IncomingMessage, device: DeviceRow): DeviceAccess {
    const primary = auth.readSession(request);
    let session = primary;
    let guest = false;
    if (session?.kind === 'guest') guest = true;
    if (session === undefined) {
      const guestSession = auth.readGuestSession(request);
      if (guestSession !== undefined) {
        session = guestSession;
        guest = true;
      }
    }
    if (session === undefined) {
      return { ok: false, status: 401, title: 'Sign in required', message: 'Sign in to the edge before opening a device.' };
    }
    if (guest) {
      if (session.deviceId !== device.id) {
        return { ok: false, status: 403, title: 'Access denied', message: 'This guest session is scoped to another device.' };
      }
      if (!device.sharingEnabled) {
        return { ok: false, status: 403, title: 'Sharing disabled', message: 'The host turned sharing off for this device.' };
      }
      if (!auth.guestAccessAllowed(session, device)) {
        return { ok: false, status: 403, title: 'Access denied', message: 'This guest session is not valid for that device.' };
      }
    } else if (!auth.deviceAccessAllowed(session, device)) {
      return { ok: false, status: 403, title: 'Access denied', message: 'This session is not paired to that device.' };
    }
    if (device.status === 'revoked') {
      return { ok: false, status: 403, title: 'Device revoked', message: 'The owner revoked this device. Ask for a new pairing.' };
    }
    if (device.status === 'pending') {
      return { ok: false, status: 403, title: 'Device pending', message: 'This device has not been approved yet.' };
    }
    return { ok: true, session, guest };
  }

  async function handleDeviceHttp(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    search: string,
  ): Promise<void> {
    const parsed = parseDevicePath(pathname);
    if (parsed === null) return sendErrorPage(response, 404, 'Not found', 'That is not a valid device path.');
    if (parsed.needsSlash) {
      return redirect(response, 302, `${pathname}/${search}`);
    }
    const device = db.getDevice(parsed.deviceId);
    if (device === undefined) return sendErrorPage(response, 404, 'Unknown device', 'No such device on this edge.');
    const access = checkDeviceAccess(request, device);
    if (!access.ok) return sendErrorPage(response, access.status, access.title, access.message, access.status === 401 ? { 'www-authenticate': 'Cookie' } : {});

    if (access.guest && (parsed.rest === '/dsh-rc' || parsed.rest.startsWith('/dsh-rc/'))) {
      return sendJsonError(response, 403, 'FORBIDDEN', 'guest sessions cannot call the host plugin');
    }
    if (hasEncodedTraversal(parsed.rest)) {
      return sendErrorPage(response, 400, 'Bad request', 'Path traversal is not allowed.');
    }
    try {
      assertSafeOriginPath(parsed.rest);
    } catch (error) {
      return sendErrorPage(response, 400, 'Bad request', error instanceof Error ? error.message : 'invalid path');
    }

    const presence = tunnels.presence(device);
    if (!presence.online) {
      // API calls get JSON (DSH's own client can retry), navigations get the
      // reconnecting page. Both carry Retry-After so well-behaved clients back
      // off instead of hammering the edge.
      const apiRequest = parsed.rest.startsWith('/api/')
        || (requestHeader(request, 'accept') ?? '').includes('application/json');
      if (apiRequest) {
        sendJson(response, 503, {
          error: 'DEVICE_OFFLINE',
          retryable: presence.reconnecting,
          reconnecting: presence.reconnecting,
          retryAfterSeconds: 5,
        }, { 'retry-after': '5' });
      } else {
        const html = reconnectingPage({ deviceName: device.name, reason: presence.reconnecting ? 'reconnecting' : 'offline' });
        sendPage(response, 503, html, { 'retry-after': '5' });
      }
      return;
    }

    await proxyDeviceHttp({
      config,
      logger,
      tunnels,
      device,
      request,
      response,
      rest: parsed.rest,
      search,
      publicOrigin: publicOrigin(request),
      ...(access.guest ? { guest: true } : {}),
    });
  }

  /* ------------------------------- upgrades ------------------------------- */

  function handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://edge.local').pathname;
    } catch {
      rejectUpgrade(socket, 400, 'invalid URL');
      return;
    }
    if (pathname === '/v1/tunnel') {
      tunnels.handleUpgrade(request, socket, head);
      return;
    }
    const parsed = parseDevicePath(pathname);
    if (parsed === null) {
      rejectUpgrade(socket, 404, 'unknown websocket path');
      return;
    }
    if (parsed.needsSlash) {
      rejectUpgrade(socket, 400, 'device path must end with /');
      return;
    }
    const device = db.getDevice(parsed.deviceId);
    if (device === undefined) {
      rejectUpgrade(socket, 404, 'unknown device');
      return;
    }
    const access = checkDeviceAccess(request, device);
    if (!access.ok) {
      rejectUpgrade(socket, access.status, access.message);
      return;
    }
    if (access.guest && (parsed.rest === '/dsh-rc' || parsed.rest.startsWith('/dsh-rc/'))) {
      rejectUpgrade(socket, 403, 'guest sessions cannot call the host plugin');
      return;
    }
    if (hasEncodedTraversal(parsed.rest)) {
      rejectUpgrade(socket, 400, 'path traversal is not allowed');
      return;
    }
    try {
      assertSafeOriginPath(parsed.rest);
    } catch (error) {
      rejectUpgrade(socket, 400, error instanceof Error ? error.message : 'invalid path');
      return;
    }
    const presence = tunnels.presence(device);
    if (!presence.online) {
      rejectUpgrade(socket, 503, presence.reconnecting ? 'reconnecting' : 'device offline', { 'retry-after': '5' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://edge.local');
    void proxyDeviceWs({
      config,
      logger,
      tunnels,
      device,
      request,
      socket,
      head,
      rest: parsed.rest,
      search: url.search,
      browserWss,
      ...(access.guest ? { guestSessionId: access.session.id, guestConnections } : {}),
    }).catch((error: unknown) => {
      logger.warn('websocket proxy failed', { deviceId: device.id, error });
      rejectUpgrade(socket, 500, 'websocket proxy failed');
    });
  }

  /* -------------------------------- server -------------------------------- */

  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      logger.error('unhandled request error', { error, method: request.method, url: request.url });
      if (!response.headersSent) sendErrorPage(response, 500, 'Internal error', 'The edge could not complete this request.');
      else response.destroy();
    });
  });
  httpServer.on('upgrade', handleUpgrade);
  httpServer.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    else socket.destroy();
  });
  server = httpServer;

  return {
    config,
    db,
    edgeId: auth.edgeId,
    startedAt,
    get setupCode() {
      return auth.setupCode;
    },
    get setupComplete() {
      return auth.setupComplete;
    },
    get origin() {
      if (config.publicUrl !== '') return config.publicUrl;
      return address?.url ?? '';
    },
    get address() {
      return address;
    },
    listen(): Promise<EdgeAddress> {
      if (address !== undefined) return Promise.resolve(address);
      return new Promise<EdgeAddress>((resolve, reject) => {
        const onError = (error: Error): void => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          httpServer.off('error', onError);
          listening = true;
          const bound = httpServer.address();
          if (bound === null || typeof bound === 'string') {
            reject(new Error('edge did not bind a TCP address'));
            return;
          }
          const url = `http://${displayHost(bound)}:${String(bound.port)}`;
          address = { host: bound.address, port: bound.port, url };
          logger.info('edge listening', { host: bound.address, port: bound.port, publicUrl: config.publicUrl });
          resolve(address);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen({ host: config.host, port: config.port });
      });
    },
    async close(): Promise<void> {
      clearInterval(auditPruneTimer);
      guestConnections.closeAll('edge shutting down');
      tunnels.closeAll('edge shutting down');
      tunnels.closeServer();
      for (const client of browserWss.clients) {
        try {
          client.terminate();
        } catch {
          /* best effort */
        }
      }
      browserWss.close();
      if (listening) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections();
        });
        listening = false;
        address = undefined;
      }
      db.close();
      logger.info('edge stopped');
    },
  };
}

/** One-shot helper used by main.ts and tests. */
export async function startEdge(overrides: Partial<EdgeConfig> = {}): Promise<{ edge: EdgeServer; address: EdgeAddress }> {
  const config = loadConfig({ overrides });
  const edge = createEdgeServer({ config });
  const bound = await edge.listen();
  return { edge, address: bound };
}