/**
 * Multiple guests at the same time: no controller lock, no 409, every guest
 * gets its own cookie, device page and WebSocket relay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  claimInvite,
  closeWebSocket,
  createGuestSession,
  createInvite,
  decideApproval,
  devicePath,
  getSharing,
  guestFetch,
  nextWsMessage,
  setSharing,
  startStack,
  waitForGuestSession,
  wsOpen,
  type GuestSession,
  type LinkStack,
} from '../harness/link.js';

async function openGuestWs(stack: LinkStack, jar: GuestSession['jar']): Promise<WebSocket> {
  const socket = new WebSocket(
    `${stack.edgeUrl.replace(/^http/, 'ws')}${devicePath(stack, '/api/remote.mux')}`,
    { headers: { cookie: jar.header() ?? '' } },
  );
  await wsOpen(socket, 10_000);
  return socket;
}

describe('multiple simultaneous guests', () => {
  let stack: LinkStack;
  let secret: string;
  let guestA: GuestSession;
  let guestB: GuestSession;

  beforeAll(async () => {
    stack = await startStack();
    secret = await stack.deviceSecret();
    expect((await setSharing(stack.edgeUrl, secret, true)).status).toBe(200);
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('claims, approves and serves two guests concurrently with no 409', async () => {
    const inviteA = await createInvite(stack.edgeUrl, secret, { label: 'A-concurrent', ttlSeconds: 0 });
    const inviteB = await createInvite(stack.edgeUrl, secret, { label: 'B-concurrent', ttlSeconds: 0 });

    const [claimA, claimB] = await Promise.all([
      claimInvite(stack.edgeUrl, inviteA.token),
      claimInvite(stack.edgeUrl, inviteB.token),
    ]);
    for (const claim of [claimA, claimB]) {
      expect(claim.status).toBe(200);
      expect(claim.json).toMatchObject({ status: 'pending', deviceId: stack.deviceId });
    }
    const approvalA = (claimA.json as { approvalId: string }).approvalId;
    const approvalB = (claimB.json as { approvalId: string }).approvalId;
    expect(approvalA).not.toBe(approvalB);

    const pending = await getSharing(stack.edgeUrl, secret);
    expect(pending.pendingApprovals).toHaveLength(2);
    expect(pending.pendingApprovals.map((entry) => entry.label).sort()).toEqual(['A-concurrent', 'B-concurrent']);

    const [decidedA, decidedB] = await Promise.all([
      decideApproval(stack.edgeUrl, secret, approvalA, 'approve'),
      decideApproval(stack.edgeUrl, secret, approvalB, 'approve'),
    ]);
    expect(decidedA.status).toBe(200);
    expect(decidedB.status).toBe(200);
    const sessionA = (decidedA.json as { sessionId: string }).sessionId;
    const sessionB = (decidedB.json as { sessionId: string }).sessionId;
    expect(sessionA).not.toBe(sessionB);

    const [statusA, statusB] = await Promise.all([
      waitForGuestSession(stack.edgeUrl, inviteA.token, claimA.jar),
      waitForGuestSession(stack.edgeUrl, inviteB.token, claimB.jar),
    ]);
    expect(statusA.state).toBe('approved');
    expect(statusB.state).toBe('approved');

    const [pageA, pageB] = await Promise.all([
      guestFetch(stack.edgeUrl, stack.deviceId, claimA.jar, '/'),
      guestFetch(stack.edgeUrl, stack.deviceId, claimB.jar, '/'),
    ]);
    expect(pageA.status).toBe(200);
    expect(pageB.status).toBe(200);
    expect(await pageA.text()).toContain('mock dsh index');
    expect(await pageB.text()).toContain('mock dsh index');

    const socketA = await openGuestWs(stack, claimA.jar);
    const socketB = await openGuestWs(stack, claimB.jar);
    try {
      const receivedA = nextWsMessage(socketA, 5000);
      const receivedB = nextWsMessage(socketB, 5000);
      socketA.send('guest-a');
      socketB.send('guest-b');
      expect((await receivedA).data.toString('utf8')).toBe('guest-a');
      expect((await receivedB).data.toString('utf8')).toBe('guest-b');
    } finally {
      await closeWebSocket(socketA);
      await closeWebSocket(socketB);
    }

    const active = await getSharing(stack.edgeUrl, secret);
    expect(active.activeGuests).toHaveLength(2);
    expect(active.activeGuests.every((guest) => guest.expiresAt === null)).toBe(true);
    expect(active.activeGuests.map((guest) => guest.sessionId).sort()).toEqual([sessionA, sessionB].sort());
    guestA = { label: 'A-concurrent', token: inviteA.token, inviteId: inviteA.id, approvalId: approvalA, sessionId: sessionA, jar: claimA.jar, status: statusA };
    guestB = { label: 'B-concurrent', token: inviteB.token, inviteId: inviteB.id, approvalId: approvalB, sessionId: sessionB, jar: claimB.jar, status: statusB };
  }, 30_000);

  it('allows a third guest to join while two are already active (no controller lock)', async () => {
    const guestC = await createGuestSession(stack, { label: 'C-late' });
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guestC.jar, '/')).status).toBe(200);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guestA.jar, '/')).status).toBe(200);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guestB.jar, '/')).status).toBe(200);

    const active = await getSharing(stack.edgeUrl, secret);
    expect(active.activeGuests).toHaveLength(3);
    expect(active.activeGuests.map((guest) => guest.label).sort()).toEqual(['A-concurrent', 'B-concurrent', 'C-late']);
  });

  it('relays interleaved WebSocket traffic from two guests independently', async () => {
    const socketA = await openGuestWs(stack, guestA.jar);
    const socketB = await openGuestWs(stack, guestB.jar);
    try {
      for (let i = 0; i < 5; i += 1) {
        const receivedA = nextWsMessage(socketA, 5000);
        const receivedB = nextWsMessage(socketB, 5000);
        socketA.send(`a-${String(i)}`);
        socketB.send(`b-${String(i)}`);
        expect((await receivedA).data.toString('utf8')).toBe(`a-${String(i)}`);
        expect((await receivedB).data.toString('utf8')).toBe(`b-${String(i)}`);
      }
    } finally {
      await closeWebSocket(socketA);
      await closeWebSocket(socketB);
    }
  });
});
