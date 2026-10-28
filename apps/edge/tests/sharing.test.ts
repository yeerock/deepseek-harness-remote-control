import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Stream } from '@dsh-rc/mux';
import { sha256Hex } from '@dsh-rc/shared';
import { DEFAULT_RATE_LIMITS } from '../src/config.js';
import { EdgeDatabase } from '../src/db.js';
import {
  Jar,
  connectTunnel,
  extractCsrf,
  http,
  provisionDevice,
  setupOwner,
  startEdge,
  startEdgeIn,
  type RegisteredDevice,
  type TestEdge,
} from './helpers.js';

const edges: TestEdge[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(overrides: Parameters<typeof startEdge>[0] = {}): Promise<TestEdge> {
  const edge = await startEdge(overrides);
  edges.push(edge);
  return edge;
}

/* ------------------------------- test helpers ------------------------------ */

interface SharingView {
  enabled: boolean;
  publicUrl: string;
  invites: Array<{ id: string; label: string; expiresAt: number; maxUses: number; uses: number }>;
  pendingApprovals: Array<{ id: string; label: string; ip: string | null; createdAt: number }>;
  activeGuests: Array<{ sessionId: string; label: string; ip: string | null; since: number; expiresAt: null }>;
}

async function deviceApi(
  base: string,
  device: RegisteredDevice,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await http(base, pathname, {
    method,
    headers: { authorization: `Bearer ${device.deviceSecret}`, accept: 'application/json' },
    ...(body === undefined ? {} : { json: body }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, body: parsed };
}

async function sharingView(base: string, device: RegisteredDevice): Promise<SharingView> {
  const response = await deviceApi(base, device, 'GET', '/v1/devices/me/sharing');
  expect(response.status).toBe(200);
  return response.body as unknown as SharingView;
}

async function setSharing(base: string, device: RegisteredDevice, enabled: boolean): Promise<number> {
  const response = await deviceApi(base, device, 'PUT', '/v1/devices/me/sharing', { enabled });
  return response.status;
}

async function createInvite(
  base: string,
  device: RegisteredDevice,
  body: Record<string, unknown> = {},
): Promise<{ id: string; url: string; token: string; expiresAt: number }> {
  const response = await deviceApi(base, device, 'POST', '/v1/devices/me/invites', body);
  expect(response.status).toBe(200);
  return response.body as unknown as { id: string; url: string; token: string; expiresAt: number };
}

async function decideApproval(
  base: string,
  device: RegisteredDevice,
  approvalId: string,
  decision: 'approve' | 'deny',
): Promise<{ status: number; body: Record<string, unknown> }> {
  return deviceApi(base, device, 'POST', `/v1/devices/me/approvals/${approvalId}`, { decision });
}

interface ClaimResult {
  jar: Jar;
  approvalId: string;
  claimResponseHeaders: string[];
}

async function claimInvite(base: string, token: string, jar = new Jar()): Promise<ClaimResult> {
  const page = await http(base, `/i/${token}`, { jar, headers: { accept: 'text/html' } });
  expect(page.status).toBe(200);
  const csrf = extractCsrf(await page.text());
  const response = await http(base, `/i/${token}/claim`, {
    method: 'POST',
    jar,
    form: { csrf },
    headers: { origin: base, accept: 'application/json' },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { approvalId: string; status: string };
  expect(body.status).toBe('pending');
  return { jar, approvalId: body.approvalId, claimResponseHeaders: response.headers.getSetCookie() };
}

async function approvedGuest(
  base: string,
  device: RegisteredDevice,
  token: string,
  label: string,
): Promise<{ jar: Jar; sessionId: string }> {
  const claimed = await claimInvite(base, token);
  const pending = await sharingView(base, device);
  const approval = pending.pendingApprovals.find((entry) => entry.id === claimed.approvalId);
  expect(approval).toBeDefined();
  expect(approval?.label).toBe(label);
  const decided = await decideApproval(base, device, claimed.approvalId, 'approve');
  expect(decided.status).toBe(200);
  const sessionId = decided.body['sessionId'];
  expect(typeof sessionId).toBe('string');

  const status = await http(base, `/i/${token}/status`, { jar: claimed.jar });
  expect(status.status).toBe(200);
  const body = (await status.json()) as { status: string; devicePath: string; sessionId: string };
  expect(body.status).toBe('approved');
  expect(body.devicePath).toBe(`/d/${device.deviceId}/`);
  expect(body.sessionId).toBe(sessionId);
  expect(claimed.jar.get('dshrc_guest')).toBeTruthy();
  expect(claimed.jar.get('dshrc_claim')).toBeUndefined();
  return { jar: claimed.jar, sessionId: sessionId as string };
}

function respondOk(stream: Stream): void {
  void (async () => {
    for await (const _chunk of stream.body()) {
      /* drain */
    }
    stream.sendHead({ status: 200, headers: [['content-type', 'text/html; charset=utf-8']] });
    await stream.write(Buffer.from('<html><body>DSH is up</body></html>'));
    await stream.end();
  })();
}

function updateDatabase(dir: string, sql: string, ...params: Array<string | number>): void {
  const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const database = new sqlite.DatabaseSync(path.join(dir, 'dshrc.sqlite'));
  try {
    database.prepare(sql).run(...params);
  } finally {
    database.close();
  }
}

/* ---------------------------------- tests --------------------------------- */

describe('device sharing API', () => {
  it('is off by default, toggles, and creates hashed, never-expiring invites', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);

    const initial = await sharingView(edge.base, device);
    expect(initial).toMatchObject({ enabled: false, publicUrl: edge.base });
    expect(initial.invites).toEqual([]);

    expect(await setSharing(edge.base, device, true)).toBe(200);
    expect((await sharingView(edge.base, device)).enabled).toBe(true);

    const invite = await createInvite(edge.base, device, { label: 'Support', ttlSeconds: 0, maxUses: 2 });
    expect(invite.expiresAt).toBe(0);
    expect(invite.url).toBe(`${edge.base}/i/${invite.token}`);
    expect(invite.token.length).toBeGreaterThanOrEqual(40);

    const row = edge.edge.db.getInvite(invite.id);
    expect(row?.tokenHash).toBe(sha256Hex(invite.token));
    expect(row?.expiresAt).toBe(0);
    expect(row?.maxUses).toBe(2);
    expect(JSON.stringify(await sharingView(edge.base, device))).not.toContain(invite.token);

    const invalidTtl = await deviceApi(edge.base, device, 'POST', '/v1/devices/me/invites', { ttlSeconds: 30 });
    expect(invalidTtl.status).toBe(400);
    const invalidUses = await deviceApi(edge.base, device, 'POST', '/v1/devices/me/invites', { maxUses: 11 });
    expect(invalidUses.status).toBe(400);
  });

  it('refuses invites while sharing is off and rejects a guest claiming after disable', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const disabled = await deviceApi(edge.base, device, 'POST', '/v1/devices/me/invites', {});
    expect(disabled.status).toBe(409);

    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { ttlSeconds: 0 });
    const page = await http(edge.base, `/i/${invite.token}`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Request access');

    await setSharing(edge.base, device, false);
    const afterDisable = await http(edge.base, `/i/${invite.token}`, { headers: { accept: 'text/html' } });
    expect(afterDisable.status).toBe(410);
    const view = await sharingView(edge.base, device);
    expect(view.invites).toEqual([]);
  });

  it('rate-limits invite creation per device', async () => {
    const edge = await boot({
      rateLimits: { ...DEFAULT_RATE_LIMITS, sharingInvite: { limit: 1, windowMs: 60_000 } },
    });
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const first = await deviceApi(edge.base, device, 'POST', '/v1/devices/me/invites', {});
    expect(first.status).toBe(200);
    const second = await deviceApi(edge.base, device, 'POST', '/v1/devices/me/invites', {});
    expect(second.status).toBe(429);
  });
});

describe('guest approval and access', () => {
  it('claims, approves, mints a permanent guest session, and limits it to one device', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const other = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { label: 'Support', ttlSeconds: 0 });

    const claimed = await claimInvite(edge.base, invite.token);
    expect(claimed.claimResponseHeaders.join(';')).toContain('dshrc_claim=');
    expect(claimed.jar.get('dshrc_claim')).toBeTruthy();

    const pendingStatus = await http(edge.base, `/i/${invite.token}/status`, { jar: claimed.jar });
    expect(pendingStatus.status).toBe(200);
    expect(await pendingStatus.json()).toMatchObject({ status: 'pending', deviceId: device.deviceId });

    const pending = await sharingView(edge.base, device);
    expect(pending.pendingApprovals).toHaveLength(1);
    expect(pending.pendingApprovals[0]?.label).toBe('Support');

    const decided = await decideApproval(edge.base, device, claimed.approvalId, 'approve');
    expect(decided.status).toBe(200);
    const sessionId = decided.body['sessionId'] as string;

    const statusResponse = await fetch(`${edge.base}/i/${invite.token}/status`, {
      headers: { cookie: claimed.jar.header(), accept: 'application/json' },
    });
    expect(statusResponse.status).toBe(200);
    const setCookies = statusResponse.headers.getSetCookie();
    const guestCookie = setCookies.find((cookie) => cookie.startsWith('dshrc_guest='));
    expect(guestCookie).toBeDefined();
    expect(guestCookie).toContain('Max-Age=315360000');
    expect(guestCookie).toContain('HttpOnly');
    const statusBody = (await statusResponse.json()) as { status: string; devicePath: string; sessionId: string };
    expect(statusBody).toMatchObject({ status: 'approved', devicePath: `/d/${device.deviceId}/`, sessionId });
    claimed.jar.ingest(statusResponse);

    const session = edge.edge.db.getSession(sessionId);
    expect(session?.kind).toBe('guest');
    expect(session?.expiresAt).toBeNull();
    expect(session?.approvalId).toBe(claimed.approvalId);
    expect((await sharingView(edge.base, device)).activeGuests).toEqual([
      expect.objectContaining({ sessionId, label: 'Support', expiresAt: null }),
    ]);

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, { onStream: respondOk });
    try {
      const allowed = await http(edge.base, `/d/${device.deviceId}/`, { jar: claimed.jar, headers: { accept: 'text/html' } });
      expect(allowed.status).toBe(200);
      const guestHtml = await allowed.text();
      expect(guestHtml).toContain('DSH is up');
      // Fixed, edge-owned pill injected into guest HTML only.
      expect(guestHtml).toContain('dshrc-guest-pill');
      expect(guestHtml).toContain('href="/i/session"');

      const ownerPage = await http(edge.base, `/d/${device.deviceId}/`, { jar: owner.jar, headers: { accept: 'text/html' } });
      expect(ownerPage.status).toBe(200);
      expect(await ownerPage.text()).not.toContain('dshrc-guest-pill');

      const otherDevice = await http(edge.base, `/d/${other.device.deviceId}/`, { jar: claimed.jar });
      expect(otherDevice.status).toBe(403);

      for (const adminPath of ['/', '/setup', '/pair', '/login', '/v1/edge', '/v1/devices/me']) {
        const admin = await http(edge.base, adminPath, { jar: claimed.jar, headers: { accept: 'application/json' } });
        expect(admin.status, adminPath).toBe(403);
      }
    } finally {
      await agent.close();
    }
  });

  it('supports several simultaneous guests with no controller lock', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const inviteA = await createInvite(edge.base, device, { label: 'Alice' });
    const inviteB = await createInvite(edge.base, device, { label: 'Bob' });
    const alice = await approvedGuest(edge.base, device, inviteA.token, 'Alice');
    const bob = await approvedGuest(edge.base, device, inviteB.token, 'Bob');

    const view = await sharingView(edge.base, device);
    expect(view.activeGuests.map((guest) => guest.label).sort()).toEqual(['Alice', 'Bob']);

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, { onStream: respondOk });
    try {
      const aliceResponse = await http(edge.base, `/d/${device.deviceId}/`, { jar: alice.jar });
      const bobResponse = await http(edge.base, `/d/${device.deviceId}/`, { jar: bob.jar });
      expect(aliceResponse.status).toBe(200);
      expect(bobResponse.status).toBe(200);
    } finally {
      await agent.close();
    }
  });

  it('revokes one guest and then all guests, closing access immediately', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const inviteA = await createInvite(edge.base, device, { label: 'Alice' });
    const inviteB = await createInvite(edge.base, device, { label: 'Bob' });
    const alice = await approvedGuest(edge.base, device, inviteA.token, 'Alice');
    const bob = await approvedGuest(edge.base, device, inviteB.token, 'Bob');

    const revokedOne = await deviceApi(edge.base, device, 'DELETE', `/v1/devices/me/guests/${alice.sessionId}`);
    expect(revokedOne.status).toBe(200);
    expect((await sharingView(edge.base, device)).activeGuests.map((guest) => guest.sessionId)).toEqual([bob.sessionId]);
    expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: alice.jar })).status).toBe(401);

    const revokedAll = await deviceApi(edge.base, device, 'DELETE', '/v1/devices/me/guests');
    expect(revokedAll.body).toEqual({ revoked: 1 });
    expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: bob.jar })).status).toBe(401);
    expect((await sharingView(edge.base, device)).activeGuests).toEqual([]);
  });

  it('lets a guest disconnect explicitly from /i/session', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { label: 'Temp' });
    const guest = await approvedGuest(edge.base, device, invite.token, 'Temp');

    const page = await http(edge.base, '/i/session', { jar: guest.jar, headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Disconnect');
    expect(html).toContain('Never');
    const csrf = extractCsrf(html);

    const disconnect = await http(edge.base, '/i/session/disconnect', {
      method: 'POST',
      jar: guest.jar,
      form: { csrf },
      headers: { origin: edge.base },
    });
    expect(disconnect.status).toBe(303);
    expect(disconnect.headers.get('location')).toBe('/');
    expect(guest.jar.get('dshrc_guest')).toBeUndefined();
    expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: guest.jar })).status).toBe(401);
    expect(edge.edge.db.getSession(guest.sessionId)).toBeUndefined();
  });

  it('closes a guest WebSocket when that guest is revoked', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { label: 'Revoked' });
    const guest = await approvedGuest(edge.base, device, invite.token, 'Revoked');

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        stream.sendOpenAck({ ok: true });
        stream.onFrame(() => undefined);
      },
    });
    const browser = new WebSocket(`${edge.base.replace(/^http/, 'ws')}/d/${device.deviceId}/api/remote.mux`, {
      headers: { cookie: guest.jar.header() },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        browser.once('open', resolve);
        browser.once('error', reject);
        browser.once('unexpected-response', (_request, response) => reject(new Error(`upgrade ${String(response.statusCode)}`)));
      });
      const closed = new Promise<number>((resolve) => {
        browser.once('close', (code) => resolve(code));
        setTimeout(() => resolve(-1), 5_000).unref();
      });
      const revoked = await deviceApi(edge.base, device, 'DELETE', `/v1/devices/me/guests/${guest.sessionId}`);
      expect(revoked.status).toBe(200);
      expect(await closed).not.toBe(-1);
    } finally {
      try {
        browser.terminate();
      } catch {
        /* already gone */
      }
      await agent.close();
    }
  });

  it('closes guest WebSockets when the host turns sharing off', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { label: 'TurnedOff' });
    const guest = await approvedGuest(edge.base, device, invite.token, 'TurnedOff');

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        stream.sendOpenAck({ ok: true });
        stream.onFrame(() => undefined);
      },
    });
    const browser = new WebSocket(`${edge.base.replace(/^http/, 'ws')}/d/${device.deviceId}/api/remote.mux`, {
      headers: { cookie: guest.jar.header() },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        browser.once('open', resolve);
        browser.once('error', reject);
        browser.once('unexpected-response', (_request, response) => reject(new Error(`upgrade ${String(response.statusCode)}`)));
      });
      const closed = new Promise<number>((resolve) => {
        browser.once('close', (code) => resolve(code));
        setTimeout(() => resolve(-1), 5_000).unref();
      });
      expect(await setSharing(edge.base, device, false)).toBe(200);
      expect(await closed).not.toBe(-1);
      expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: guest.jar })).status).toBe(401);
      expect((await sharingView(edge.base, device)).activeGuests).toEqual([]);
    } finally {
      try {
        browser.terminate();
      } catch {
        /* already gone */
      }
      await agent.close();
    }
  });

  it('expires invites and their pending approvals', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { label: 'Expiring', ttlSeconds: 60 });
    const claimed = await claimInvite(edge.base, invite.token);
    updateDatabase(edge.dir, 'UPDATE invites SET expires_at = ? WHERE id = ?', 1, invite.id);

    const status = await http(edge.base, `/i/${invite.token}/status`, { jar: claimed.jar });
    expect(await status.json()).toMatchObject({ status: 'expired' });
    const page = await http(edge.base, `/i/${invite.token}`, { jar: claimed.jar });
    expect(page.status).toBe(410);
    const denied = await decideApproval(edge.base, device, claimed.approvalId, 'approve');
    expect(denied.status).toBe(409);
  });

  it('honours maxUses for multi-use invites', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { label: 'Team', maxUses: 2 });
    const first = await claimInvite(edge.base, invite.token);
    const second = await claimInvite(edge.base, invite.token, new Jar());
    expect(first.approvalId).not.toBe(second.approvalId);
    await expect(claimInvite(edge.base, invite.token, new Jar())).rejects.toThrow();
    expect((await sharingView(edge.base, device)).invites[0]?.uses).toBe(2);
  });

  it('denies a pending approval and reports it through /status', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await setSharing(edge.base, device, true);
    const invite = await createInvite(edge.base, device, { label: 'Denied' });
    const claimed = await claimInvite(edge.base, invite.token);
    expect((await decideApproval(edge.base, device, claimed.approvalId, 'deny')).status).toBe(200);
    const status = await http(edge.base, `/i/${invite.token}/status`, { jar: claimed.jar });
    expect(await status.json()).toMatchObject({ status: 'denied' });
    expect(claimed.jar.get('dshrc_guest')).toBeUndefined();
  });
});

describe('guest permanence', () => {
  it('keeps a guest session valid across an edge restart with no expiry row', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dshrc-sharing-restart-'));
    cleanupDirs.push(dir);
    const first = await startEdgeIn(dir);
    const owner = await setupOwner(first.base);
    const { device } = await provisionDevice(first.base, owner.jar);
    await setSharing(first.base, device, true);
    const invite = await createInvite(first.base, device, { label: 'Permanent', ttlSeconds: 0 });
    const guest = await approvedGuest(first.base, device, invite.token, 'Permanent');
    expect(first.edge.db.getSession(guest.sessionId)?.expiresAt).toBeNull();
    await first.close();

    const second = await startEdgeIn(dir);
    try {
      // Same signed cookie, same persisted secret, same SQLite row.
      const sessionPage = await http(second.base, '/i/session', { jar: guest.jar, headers: { accept: 'text/html' } });
      expect(sessionPage.status).toBe(200);
      expect(await sessionPage.text()).toContain('Permanent');
      const devicePage = await http(second.base, `/d/${device.deviceId}/`, { jar: guest.jar });
      expect(devicePage.status).toBe(503); // agent offline, but the guest session is valid
      expect(second.edge.db.getSession(guest.sessionId)?.expiresAt).toBeNull();
    } finally {
      await second.close();
    }
  });
});


describe('schema migration', () => {
  it('migrates a v1 database in place and keeps existing sessions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dshrc-sharing-migrate-'));
    cleanupDirs.push(dir);
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const raw = new sqlite.DatabaseSync(path.join(dir, 'dshrc.sqlite'));
    try {
      raw.exec(`
        CREATE TABLE devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          agent_version TEXT NOT NULL,
          secret_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          approved_at INTEGER,
          revoked_at INTEGER,
          last_seen_at INTEGER,
          last_connected_at INTEGER
        ) STRICT;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
          csrf_token TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          ip TEXT,
          user_agent TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      const now = Date.now();
      raw.prepare('INSERT INTO devices (id, name, platform, agent_version, secret_hash, status, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('dev_aaaaaaaaaaaaaaaaaaaa', 'old device', 'test', '0.1.0', 'hash', 'approved', now, now);
      raw.prepare('INSERT INTO sessions (id, kind, device_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('sess_old', 'device', 'dev_aaaaaaaaaaaaaaaaaaaa', 'csrf', now, now + 60_000, now);
    } finally {
      raw.close();
    }

    const database = new EdgeDatabase(dir);
    try {
      expect(database.getDevice('dev_aaaaaaaaaaaaaaaaaaaa')?.sharingEnabled).toBe(false);
      expect(database.getSession('sess_old')?.expiresAt).toBeGreaterThan(0);
      database.setSharingEnabled('dev_aaaaaaaaaaaaaaaaaaaa', true, Date.now());
      expect(database.getDevice('dev_aaaaaaaaaaaaaaaaaaaa')?.sharingEnabled).toBe(true);
      const guest = database.createSession({
        kind: 'guest',
        deviceId: 'dev_aaaaaaaaaaaaaaaaaaaa',
        csrfToken: 'csrf2',
        createdAt: Date.now(),
        expiresAt: null,
        ip: null,
        userAgent: null,
        approvalId: null,
      });
      expect(guest.expiresAt).toBeNull();
      const invite = database.insertInvite({
        id: 'inv_migration_test',
        deviceId: 'dev_aaaaaaaaaaaaaaaaaaaa',
        tokenHash: 'abc123',
        label: 'Migrated',
        createdAt: Date.now(),
        expiresAt: 0,
        maxUses: 1,
      });
      expect(invite.expiresAt).toBe(0);
    } finally {
      database.close();
    }

    const reopened = new EdgeDatabase(dir);
    try {
      expect(reopened.getSession('sess_old')?.kind).toBe('device');
      expect(reopened.getGuestSessionLabel(guestIdOf(reopened))).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});

function guestIdOf(database: EdgeDatabase): string {
  return database.listGuestSessions('dev_aaaaaaaaaaaaaaaaaaaa')[0]?.id ?? 'missing';
}
