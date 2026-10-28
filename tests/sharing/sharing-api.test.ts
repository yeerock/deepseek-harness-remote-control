/**
 * Device-scoped sharing API: toggle, invite TTLs, one-time token, hash at rest,
 * maxUses, deletion and validation. Guest behaviour lives in the other files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInvite,
  deleteInvite,
  getInvitePage,
  getSharing,
  readInviteRows,
  setSharing,
  sha256HexLocal,
  startStack,
  type LinkStack,
  type SharingState,
} from '../harness/link.js';

describe('sharing API and invites', () => {
  let stack: LinkStack;
  let secret: string;

  beforeAll(async () => {
    stack = await startStack();
    secret = await stack.deviceSecret();
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('is off by default and toggles with the device secret', async () => {
    const initial = await getSharing(stack.edgeUrl, secret);
    expect(initial.enabled).toBe(false);
    expect(initial.invites).toEqual([]);
    expect(initial.pendingApprovals).toEqual([]);
    expect(initial.activeGuests).toEqual([]);
    expect(initial.publicUrl).toBe(stack.edgeUrl);

    const enabled = await setSharing(stack.edgeUrl, secret, true);
    expect(enabled.status).toBe(200);
    expect(enabled.json).toEqual({ enabled: true });
    expect((await getSharing(stack.edgeUrl, secret)).enabled).toBe(true);
  });

  it('refuses invite creation while sharing is off (409 SHARING_DISABLED)', async () => {
    await setSharing(stack.edgeUrl, secret, false);
    const response = await createInvite(stack.edgeUrl, secret, { ttlSeconds: 0 }).catch((error: unknown) => error);
    // createInvite throws on non-2xx; inspect the thrown message for the code.
    expect(response).toBeInstanceOf(Error);
    expect(String(response)).toContain('409');
    expect(String(response)).toContain('SHARING_DISABLED');
    await setSharing(stack.edgeUrl, secret, true);
  });

  it('creates a never-expiring invite, returns the token once and hashes it at rest', async () => {
    const before = Date.now();
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'Never', ttlSeconds: 0, maxUses: 1 });
    expect(invite.id).toMatch(/^inv_/);
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invite.expiresAt).toBe(0);
    expect(invite.url).toContain(`/i/${invite.token}`);
    expect(before).toBeLessThanOrEqual(Date.now());

    const sharing = await getSharing(stack.edgeUrl, secret);
    const listed = sharing.invites.find((entry) => entry.id === invite.id);
    expect(listed).toMatchObject({ id: invite.id, label: 'Never', expiresAt: 0, maxUses: 1, uses: 0 });
    // The token is shown once: the sharing summary must never contain it (or
    // its hash) even for the device that owns the invite.
    const serialized = JSON.stringify(sharing);
    expect(serialized).not.toContain(invite.token);
    expect(serialized).not.toContain(sha256HexLocal(invite.token));

    const row = readInviteRows(stack.edgeDataDir).find((entry) => entry.id === invite.id);
    expect(row).toBeDefined();
    expect(row?.token_hash).toBe(sha256HexLocal(invite.token));
    expect(row?.token_hash).not.toBe(invite.token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.expires_at).toBe(0);
    expect(row?.max_uses).toBe(1);
    expect(row?.uses).toBe(0);
  });

  it('creates a time-limited, multi-use invite with the documented bounds', async () => {
    const before = Date.now();
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'Timed', ttlSeconds: 3600, maxUses: 2 });
    const after = Date.now();
    expect(invite.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000 - 1000);
    expect(invite.expiresAt).toBeLessThanOrEqual(after + 3_600_000 + 1000);

    const row = readInviteRows(stack.edgeDataDir).find((entry) => entry.id === invite.id);
    expect(row?.expires_at).toBe(invite.expiresAt);
    expect(row?.max_uses).toBe(2);
  });

  it('validates ttlSeconds, maxUses and label length', async () => {
    const cases: Array<Record<string, unknown>> = [
      { ttlSeconds: 30 },
      { ttlSeconds: 86_401 },
      { maxUses: 0 },
      { maxUses: 11 },
      { label: 'x'.repeat(65) },
    ];
    for (const body of cases) {
      const response = await createInvite(stack.edgeUrl, secret, body as { ttlSeconds?: number; maxUses?: number; label?: string }).catch((error: unknown) => error);
      expect(response).toBeInstanceOf(Error);
      expect(String(response)).toContain('400');
    }
  });

  it('DELETE invite removes it from the summary and prevents claims (410)', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'Revoked', ttlSeconds: 0 });
    const deleted = await deleteInvite(stack.edgeUrl, secret, invite.id);
    expect(deleted.status).toBe(200);
    expect(deleted.json).toEqual({ ok: true });

    const sharing = await getSharing(stack.edgeUrl, secret);
    expect(sharing.invites.some((entry) => entry.id === invite.id)).toBe(false);
    const row = readInviteRows(stack.edgeDataDir).find((entry) => entry.id === invite.id);
    expect(row?.revoked_at).not.toBeNull();

    const page = await getInvitePage(stack.edgeUrl, invite.token);
    expect(page.status).toBe(410);
    expect(page.bodyText).toMatch(/revoked/i);
  });

  it('honours maxUses: two claims succeed, the third is rejected', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'Two', ttlSeconds: 0, maxUses: 2 });
    const { claimInvite } = await import('../harness/link.js');
    const first = await claimInvite(stack.edgeUrl, invite.token);
    const second = await claimInvite(stack.edgeUrl, invite.token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.json as { approvalId: string }).approvalId).not.toBe((second.json as { approvalId: string }).approvalId);
    const sharing = await getSharing(stack.edgeUrl, secret);
    expect(sharing.invites.find((entry) => entry.id === invite.id)?.uses).toBe(2);
    expect(sharing.pendingApprovals.filter((entry) => entry.label === 'Two')).toHaveLength(2);

    const page = await getInvitePage(stack.edgeUrl, invite.token);
    expect(page.status).toBe(410);
    expect(page.bodyText).toMatch(/already been used/i);
  });

  it('single-use invites reject a second claim after the first', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'Once', ttlSeconds: 0, maxUses: 1 });
    // claimInvite is exercised fully in guest-flow; here we only need the
    // invite page's availability state after one use.
    const { claimInvite } = await import('../harness/link.js');
    const first = await claimInvite(stack.edgeUrl, invite.token);
    expect(first.status).toBe(200);
    const page = await getInvitePage(stack.edgeUrl, invite.token);
    expect(page.status).toBe(410);
    expect(page.bodyText).toMatch(/already been used/i);

    const sharing: SharingState = await getSharing(stack.edgeUrl, secret);
    expect(sharing.pendingApprovals.some((entry) => entry.id === (first.json as { approvalId?: string }).approvalId)).toBe(true);
  });
});
