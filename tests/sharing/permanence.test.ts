/**
 * Guest sessions are permanent seats, not demo sessions: `expiresAt: null`,
 * 10-year cookie, survive an edge restart with the same data dir, and have no
 * idle timeout (checked after a real >60 s quiet period).
 *
 * The 61 s idle test is intentional: it is the only way to prove the absence of
 * an idle-expiry rule. Other sharing files run in parallel, so the suite wall
 * time stays within the task's 90 s budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GUEST_COOKIE,
  createGuestSession,
  delay,
  getSharing,
  guestFetch,
  readSessionRows,
  setSharing,
  startStack,
  waitFor,
  type GuestSession,
  type LinkStack,
} from '../harness/link.js';

describe('guest permanence and restart survival', () => {
  let stack: LinkStack;
  let secret: string;
  let guest: GuestSession;

  beforeAll(async () => {
    stack = await startStack();
    secret = await stack.deviceSecret();
    expect((await setSharing(stack.edgeUrl, secret, true)).status).toBe(200);
    guest = await createGuestSession(stack, { label: 'Permanent' });
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('mints a guest session with expiresAt null, a 10-year cookie and no DB expiry', async () => {
    expect(guest.sessionId).toBeDefined();
    const sharing = await getSharing(stack.edgeUrl, secret);
    const active = sharing.activeGuests.find((entry) => entry.sessionId === guest.sessionId);
    expect(active).toMatchObject({ sessionId: guest.sessionId, label: 'Permanent', expiresAt: null });
    expect(typeof active?.since).toBe('number');

    const cookie = guest.status.setCookies.find((header) => header.startsWith(`${GUEST_COOKIE}=`));
    expect(cookie).toBeDefined();
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie ?? '')?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(10 * 365 * 24 * 60 * 60 - 60);

    const row = readSessionRows(stack.edgeDataDir).find((entry) => entry.id === guest.sessionId);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('guest');
    expect(row?.expires_at).toBeNull();
    expect(row?.device_id).toBe(stack.deviceId);
    expect(row?.approval_id).toBe(guest.approvalId);
  });

  it('survives an edge restart with the same data dir and a live agent reconnect', async () => {
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/')).status).toBe(200);
    const before = await getSharing(stack.edgeUrl, secret);
    expect(before.activeGuests.some((entry) => entry.sessionId === guest.sessionId)).toBe(true);

    await stack.restartEdge();

    // 503 while the agent reconnects is fine; 401 would mean the guest session
    // did not survive. Poll until the full device page returns.
    const page = await waitFor(async () => {
      const response = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/');
      if (response.status === 401) throw new Error('guest session was lost across the edge restart');
      if (response.status !== 200) return undefined;
      const body = await response.text();
      return body.includes('mock dsh index') ? body : undefined;
    }, { timeoutMs: 20_000, intervalMs: 50, label: 'guest page after edge restart' });
    expect(page).toContain('mock dsh index');

    const after = await getSharing(stack.edgeUrl, secret);
    const active = after.activeGuests.find((entry) => entry.sessionId === guest.sessionId);
    expect(active).toMatchObject({ sessionId: guest.sessionId, expiresAt: null });
    expect(after.pendingApprovals).toEqual([]);
  }, 30_000);

  it('has no idle timeout: still valid after more than 60 seconds of silence', async () => {
    await delay(61_000);
    const response = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('mock dsh index');
    const sharing = await getSharing(stack.edgeUrl, secret);
    expect(sharing.activeGuests.some((entry) => entry.sessionId === guest.sessionId)).toBe(true);
  }, 80_000);
});
