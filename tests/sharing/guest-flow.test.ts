/**
 * Guest end-to-end flows: claim -> pending approval -> approve -> guest cookie,
 * admin isolation, explicit disconnect, revoke one/all, sharing off, device
 * revoke, and WebSocket continuity across an agent tunnel restart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  CLAIM_COOKIE,
  GUEST_COOKIE,
  browserFetch,
  claimInvite,
  closeWebSocket,
  createGuestSession,
  createInvite,
  decideApproval,
  devicePath,
  disconnectGuest,
  getGuestSessionPage,
  getInvitePage,
  getSharing,
  guestFetch,
  nextWsMessage,
  rawRequest,
  registerDevice,
  revokeAllGuests,
  revokeDevice,
  revokeGuest,
  setSharing,
  startStack,
  waitFor,
  waitForGuestSession,
  waitForWsClose,
  wsOpen,
  type GuestSession,
  type LinkStack,
} from '../harness/link.js';

const DEVICE_PAGE = 'mock dsh index';

async function openGuestWs(stack: LinkStack, guest: GuestSession): Promise<WebSocket> {
  const socket = new WebSocket(
    `${stack.edgeUrl.replace(/^http/, 'ws')}${devicePath(stack, '/api/remote.mux')}`,
    { headers: { cookie: guest.jar.header() ?? '' } },
  );
  await wsOpen(socket, 10_000);
  return socket;
}

async function echo(socket: WebSocket, message: string): Promise<string> {
  const received = nextWsMessage(socket, 5000);
  socket.send(message);
  return (await received).data.toString('utf8');
}

describe('guest sessions', () => {
  let stack: LinkStack;
  let secret: string;

  beforeAll(async () => {
    stack = await startStack();
    secret = await stack.deviceSecret();
    const enabled = await setSharing(stack.edgeUrl, secret, true);
    expect(enabled.status).toBe(200);
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('claim -> pending -> approve -> guest cookie -> device page', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'Support', ttlSeconds: 600 });
    const claim = await claimInvite(stack.edgeUrl, invite.token);
    expect(claim.status).toBe(200);
    expect(claim.json).toMatchObject({ status: 'pending', deviceId: stack.deviceId });
    expect(claim.jar.get(CLAIM_COOKIE)).toBeDefined();

    const pending = await getSharing(stack.edgeUrl, secret);
    const approval = pending.pendingApprovals.find((entry) => entry.id === (claim.json as { approvalId: string }).approvalId);
    expect(approval).toMatchObject({ id: (claim.json as { approvalId: string }).approvalId, label: 'Support', ip: '127.0.0.1' });
    expect(typeof approval?.createdAt).toBe('number');

    const decided = await decideApproval(stack.edgeUrl, secret, approval!.id, 'approve');
    expect(decided.status).toBe(200);
    expect((decided.json as { ok: boolean }).ok).toBe(true);
    const sessionId = (decided.json as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^sess_/);

    const status = await waitForGuestSession(stack.edgeUrl, invite.token, claim.jar);
    expect(status.state).toBe('approved');
    expect(status.json).toMatchObject({ status: 'approved', deviceId: stack.deviceId, devicePath: `/d/${stack.deviceId}/`, sessionId });
    expect(claim.jar.get(GUEST_COOKIE)).toBeDefined();
    expect(claim.jar.get(CLAIM_COOKIE)).toBeUndefined();

    const guestCookie = status.setCookies.find((header) => header.startsWith(`${GUEST_COOKIE}=`));
    expect(guestCookie).toBeDefined();
    const maxAge = Number(/Max-Age=(\d+)/i.exec(guestCookie ?? '')?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(10 * 365 * 24 * 60 * 60 - 60);

    const page = await guestFetch(stack.edgeUrl, stack.deviceId, claim.jar, '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(DEVICE_PAGE);

    const active = await getSharing(stack.edgeUrl, secret);
    expect(active.activeGuests.find((guest) => guest.sessionId === sessionId)).toMatchObject({
      sessionId,
      label: 'Support',
      expiresAt: null,
    });
    expect((await getGuestSessionPage(stack.edgeUrl, claim.jar)).response.status).toBe(200);
  });

  it('limits a guest to its own /d/ mount and returns 403 on every admin route', async () => {
    const guest = await createGuestSession(stack, { label: 'Isolation' });
    const cookie = guest.jar.header() ?? '';

    const adminGets = ['/', '/setup', '/pair', '/login'];
    for (const path of adminGets) {
      const response = await rawRequest(stack.edgeUrl, { path, headers: { cookie } });
      expect(response.status, `GET ${path}`).toBe(403);
    }
    for (const path of ['/v1/edge', '/v1/devices/me', '/v1/devices/me/sharing']) {
      const response = await rawRequest(stack.edgeUrl, { path, headers: { cookie, accept: 'application/json' } });
      expect(response.status, `GET ${path}`).toBe(403);
      expect(response.bodyText).toContain('FORBIDDEN');
    }
    for (const path of ['/logout', `/v1/devices/${stack.deviceId}/approve`, `/v1/devices/${stack.deviceId}/revoke`]) {
      const response = await rawRequest(stack.edgeUrl, {
        method: 'POST',
        path,
        headers: { cookie, origin: stack.edgeUrl },
        body: '',
      });
      expect(response.status, `POST ${path}`).toBe(403);
    }

    const other = await registerDevice(stack.edgeUrl, 'not-my-device');
    const foreign = await guestFetch(stack.edgeUrl, other.deviceId, guest.jar, '/');
    expect(foreign.status).toBe(403);

    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/')).status).toBe(200);
    expect((await getGuestSessionPage(stack.edgeUrl, guest.jar)).response.status).toBe(200);
  });

  it('POST /i/session/disconnect clears the cookie, session and live WebSocket', async () => {
    const guest = await createGuestSession(stack, { label: 'Leaver' });
    const socket = await openGuestWs(stack, guest);
    expect(await echo(socket, 'before-disconnect')).toBe('before-disconnect');
    const closed = waitForWsClose(socket, 5000);

    const response = await disconnectGuest(stack.edgeUrl, guest.jar);
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/');
    expect(guest.jar.get(GUEST_COOKIE)).toBeUndefined();
    const close = await closed;
    expect(close.code).toBe(1008);

    const after = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/');
    expect(after.status).toBe(401);
    expect((await getSharing(stack.edgeUrl, secret)).activeGuests.some((entry) => entry.sessionId === guest.sessionId)).toBe(false);
  });

  it('revoking one guest leaves the other guest and its WebSocket intact', async () => {
    const guestA = await createGuestSession(stack, { label: 'A' });
    const guestB = await createGuestSession(stack, { label: 'B' });
    expect(guestA.sessionId).toBeDefined();
    expect(guestB.sessionId).toBeDefined();
    expect(guestA.sessionId).not.toBe(guestB.sessionId);

    const socketA = await openGuestWs(stack, guestA);
    const socketB = await openGuestWs(stack, guestB);
    const closedA = waitForWsClose(socketA, 5000);

    const revoked = await revokeGuest(stack.edgeUrl, secret, guestA.sessionId!);
    expect(revoked.status).toBe(200);
    expect(revoked.json).toEqual({ ok: true });
    expect((await closedA).code).toBe(1008);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guestA.jar, '/')).status).toBe(401);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guestB.jar, '/')).status).toBe(200);
    expect(await echo(socketB, 'b-still-here')).toBe('b-still-here');
    await closeWebSocket(socketB);
  });

  it('DELETE /v1/devices/me/guests revokes every guest and closes their sockets', async () => {
    const guestA = await createGuestSession(stack, { label: 'All-A' });
    const guestB = await createGuestSession(stack, { label: 'All-B' });
    const socketA = await openGuestWs(stack, guestA);
    const socketB = await openGuestWs(stack, guestB);
    const closed = Promise.all([waitForWsClose(socketA, 5000), waitForWsClose(socketB, 5000)]);

    const revoked = await revokeAllGuests(stack.edgeUrl, secret);
    expect(revoked.status).toBe(200);
    expect((revoked.json as { revoked: number }).revoked).toBeGreaterThanOrEqual(2);
    for (const close of await closed) expect(close.code).toBe(1008);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guestA.jar, '/')).status).toBe(401);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guestB.jar, '/')).status).toBe(401);
    expect((await getSharing(stack.edgeUrl, secret)).activeGuests).toEqual([]);
  });

  it('disabling sharing invalidates guests, invites and live sockets; re-enabling does not resurrect them', async () => {
    const guest = await createGuestSession(stack, { label: 'Offline' });
    const pendingInvite = await createInvite(stack.edgeUrl, secret, { label: 'Unclaimed', ttlSeconds: 0 });
    const socket = await openGuestWs(stack, guest);
    const closed = waitForWsClose(socket, 5000);

    const disabled = await setSharing(stack.edgeUrl, secret, false);
    expect(disabled.status).toBe(200);
    expect((await closed).code).toBe(1008);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/')).status).toBe(401);

    const summary = await getSharing(stack.edgeUrl, secret);
    expect(summary.enabled).toBe(false);
    expect(summary.invites).toEqual([]);
    expect(summary.pendingApprovals).toEqual([]);
    expect(summary.activeGuests).toEqual([]);
    expect((await getInvitePage(stack.edgeUrl, pendingInvite.token)).status).toBe(410);

    expect((await setSharing(stack.edgeUrl, secret, true)).status).toBe(200);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/')).status).toBe(401);
  });

  it('keeps the guest session across an agent tunnel restart without re-approval', async () => {
    const guest = await createGuestSession(stack, { label: 'Resilient' });
    const before = await getSharing(stack.edgeUrl, secret);
    expect(before.activeGuests.some((entry) => entry.sessionId === guest.sessionId)).toBe(true);

    const firstSocket = await openGuestWs(stack, guest);
    expect(await echo(firstSocket, 'pre-restart')).toBe('pre-restart');

    await stack.restartAgent();
    await waitFor(async () => {
      const response = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/');
      return response.status === 200;
    }, { timeoutMs: 15_000, intervalMs: 50, label: 'device page after agent restart' });

    // The old browser socket may be closed by the transport reset; either way a
    // new socket with the same guest cookie must work and the session must not
    // need re-approval.
    let oldSocketUsable = false;
    if (firstSocket.readyState === WebSocket.OPEN) {
      try {
        oldSocketUsable = (await echo(firstSocket, 'post-restart')) === 'post-restart';
      } catch {
        oldSocketUsable = false;
      }
    }
    if (!oldSocketUsable) {
      const replacement = await openGuestWs(stack, guest);
      try {
        expect(await echo(replacement, 'post-restart')).toBe('post-restart');
      } finally {
        await closeWebSocket(replacement);
      }
    }
    await closeWebSocket(firstSocket).catch(() => undefined);

    const after = await getSharing(stack.edgeUrl, secret);
    expect(after.pendingApprovals).toEqual([]);
    expect(after.activeGuests.filter((entry) => entry.sessionId === guest.sessionId)).toHaveLength(1);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/')).status).toBe(200);
  }, 30_000);

  it('device revoke invalidates guest sessions and closes their sockets', async () => {
    const guest = await createGuestSession(stack, { label: 'Doomed' });
    const socket = await openGuestWs(stack, guest);
    const closed = waitForWsClose(socket, 8000);

    const revoked = await revokeDevice(stack.edgeUrl, stack.owner, stack.deviceId);
    expect(revoked.status).toBeGreaterThanOrEqual(200);
    expect(revoked.status).toBeLessThan(400);

    const close = await closed;
    expect([1008, 1011, 1012, 1001]).toContain(close.code);
    const after = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/');
    expect([401, 403]).toContain(after.status);
    await waitFor(() => stack.agent.status().state === 'error', {
      timeoutMs: 5000,
      intervalMs: 25,
      label: 'agent terminal after device revoke',
    });
  });
});
