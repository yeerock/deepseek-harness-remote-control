import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharingClient, SharingError } from '../src/sharing.js';
import { dispatchEndpoint } from '../src/host.js';
import type { SharingRpcTarget } from '../src/host.js';

const SCRATCH: string[] = [];
const SECRET = 'device-secret-must-never-appear-123';

function makeStateDir(options: { secret?: string; mode?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rc-sharing-test-'));
  SCRATCH.push(dir);
  const file = join(dir, 'device.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      deviceId: 'dev_testtesttesttesttest1',
      deviceSecret: options.secret ?? SECRET,
      edgeUrl: 'http://edge.test',
      name: 'test-device',
      createdAt: 1,
    }),
    { mode: 0o600 },
  );
  if (options.mode !== undefined && process.platform !== 'win32') chmodSync(file, options.mode);
  return dir;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function mockFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  while (SCRATCH.length > 0) {
    const dir = SCRATCH.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SharingClient', () => {
  it('authenticates device-scoped GET requests with the Bearer device secret', async () => {
    const { impl, calls } = mockFetch(() =>
      json({
        enabled: true,
        publicUrl: 'https://edge.example',
        invites: [{ id: 'inv_1', label: 'Support', expiresAt: 0, maxUses: 1, uses: 0 }],
        pendingApprovals: [{ id: 'apr_1', label: 'Support', ip: '203.0.113.9', createdAt: 10 }],
        activeGuests: [{ sessionId: 'sess_1', label: 'Support', ip: '203.0.113.9', since: 20, expiresAt: null }],
      }),
    );
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test/', fetchImpl: impl });
    const state = await client.getSharing();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://edge.test/v1/devices/me/sharing', method: 'GET' });
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${SECRET}`);
    expect(state).toMatchObject({ enabled: true, publicUrl: 'https://edge.example' });
    expect(state.pendingApprovals[0]).toMatchObject({ id: 'apr_1', ip: '203.0.113.9' });
    expect(state.activeGuests[0]).toMatchObject({ sessionId: 'sess_1', expiresAt: null });
  });

  it('sends the documented bodies for sharing toggles, invites and approvals', async () => {
    const { impl, calls } = mockFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/invites')) {
        return json({ id: 'inv_2', url: 'https://edge.example/i/token', token: 'token', expiresAt: 0 });
      }
      return json({ enabled: true, ok: true });
    });
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test', fetchImpl: impl });

    await client.setSharing(true);
    const invite = await client.createInvite({ label: 'Support', ttlSeconds: 0, maxUses: 2 });
    await client.decideApproval('apr_1', 'approve');

    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'http://edge.test/v1/devices/me/sharing' });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ enabled: true });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'http://edge.test/v1/devices/me/invites' });
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ label: 'Support', ttlSeconds: 0, maxUses: 2 });
    expect(invite).toEqual({ id: 'inv_2', url: 'https://edge.example/i/token', token: 'token', expiresAt: 0 });
    expect(calls[2]).toMatchObject({ method: 'POST', url: 'http://edge.test/v1/devices/me/approvals/apr_1' });
    expect(JSON.parse(calls[2]?.body ?? '')).toEqual({ decision: 'approve' });
  });

  it('maps revoke calls to the documented DELETE routes', async () => {
    const { impl, calls } = mockFetch((call) =>
      call.method === 'DELETE' && call.url.endsWith('/guests') ? json({ revoked: 3 }) : json({ ok: true }),
    );
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test', fetchImpl: impl });

    await client.revokeInvite('inv_1');
    await client.revokeGuest('sess_1');
    const all = await client.revokeAllGuests();

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE http://edge.test/v1/devices/me/invites/inv_1',
      'DELETE http://edge.test/v1/devices/me/guests/sess_1',
      'DELETE http://edge.test/v1/devices/me/guests',
    ]);
    expect(all).toEqual({ revoked: 3 });
  });

  it('rejects invalid arguments before touching the network', async () => {
    const { impl, calls } = mockFetch(() => json({ ok: true }));
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test', fetchImpl: impl });

    await expect(client.createInvite({ ttlSeconds: 30 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(client.createInvite({ maxUses: 11 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(client.decideApproval('apr_1', 'maybe' as 'approve')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(0);
  });

  it('maps edge HTTP errors to typed failures with the remote code', async () => {
    const { impl } = mockFetch(() =>
      json({ error: { code: 'RATE_LIMITED', message: 'Too many invites.' } }, 429, { 'retry-after': '12' }),
    );
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test', fetchImpl: impl });

    await expect(client.createInvite({ ttlSeconds: 900 })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      remoteCode: 'RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 12,
      message: 'Too many invites.',
    });
  });

  it('redacts a secret echoed back in an edge error message', async () => {
    const { impl } = mockFetch(() => json({ error: { code: 'BAD_REQUEST', message: `bad token ${SECRET}` } }, 400));
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test', fetchImpl: impl });
    await expect(client.getSharing()).rejects.toSatisfy((error: unknown) => {
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).toContain('[redacted]');
      return true;
    });
  });

  it('maps transport failures without leaking the secret or the URL', async () => {
    const { impl } = mockFetch(() => {
      throw new Error(`connect ECONNREFUSED ${SECRET}`);
    });
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test', fetchImpl: impl });

    await expect(client.getSharing()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(SharingError);
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('edge.test');
      expect((error as SharingError).code).toBe('TRANSPORT_ERROR');
      return true;
    });
  });

  it('refuses a missing or world-readable device identity', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-rc-sharing-empty-'));
    SCRATCH.push(empty);
    const { impl } = mockFetch(() => json({}));
    const missing = new SharingClient({ stateDir: empty, edgeUrl: 'http://edge.test', fetchImpl: impl });
    await expect(missing.getSharing()).rejects.toMatchObject({ code: 'IDENTITY_MISSING' });

    if (process.platform !== 'win32') {
      const loose = new SharingClient({ stateDir: makeStateDir({ mode: 0o644 }), edgeUrl: 'http://edge.test', fetchImpl: impl });
      await expect(loose.getSharing()).rejects.toMatchObject({ code: 'IDENTITY_INSECURE' });
    }
  });

  it('never logs the device secret', async () => {
    const entries: string[] = [];
    const logger = {
      debug: (message: string, fields?: Record<string, unknown>) => entries.push(`${message} ${JSON.stringify(fields ?? {})}`),
      warn: (message: string, fields?: Record<string, unknown>) => entries.push(`${message} ${JSON.stringify(fields ?? {})}`),
    };
    const { impl } = mockFetch(() => json({ enabled: false, publicUrl: '', invites: [], pendingApprovals: [], activeGuests: [] }));
    const client = new SharingClient({ stateDir: makeStateDir(), edgeUrl: 'http://edge.test', fetchImpl: impl, logger });
    await client.getSharing();

    const logged = entries.join('\n');
    expect(logged).toContain('edge request');
    expect(logged).not.toContain(SECRET);
    expect(logged.toLowerCase()).not.toContain('bearer');
  });
});

describe('sharing RPC dispatch', () => {
  function target(overrides: Partial<SharingRpcTarget> = {}): SharingRpcTarget {
    const base: SharingRpcTarget = {
      status: () => ({ state: 'stopped' } as never),
      start: async () => ({ state: 'starting' } as never),
      restart: async () => ({ state: 'restarting' } as never),
      stop: async () => ({ state: 'stopped' } as never),
      pairUrl: () => undefined,
      sharingGet: async () => ({ enabled: false, publicUrl: '', invites: [], pendingApprovals: [], activeGuests: [] }),
      sharingSet: async (enabled) => ({ enabled }),
      sharingInvite: async (input) => ({ id: 'inv_1', url: 'https://edge/i/t', token: 't', expiresAt: 0, ...input }),
      sharingRevokeInvite: async () => ({ ok: true }),
      sharingDecide: async () => ({ ok: true }),
      sharingRevokeGuest: async () => ({ ok: true }),
      sharingRevokeAll: async () => ({ revoked: 0 }),
      updateCheck: async () => ({ state: 'online' } as never),
      updateRestart: () => ({ state: 'online' } as never),
    };
    return { ...base, ...overrides };
  }

  it('validates payloads and forwards sharing calls', async () => {
    const set = vi.fn(async (enabled: boolean) => ({ enabled }));
    const invite = vi.fn(async (input: { ttlSeconds?: number; label?: string }) => ({
      id: 'inv_1',
      url: 'https://edge/i/t',
      token: 't',
      expiresAt: 0,
      ...input,
    }));
    const t = target({ sharingSet: set, sharingInvite: invite });

    await expect(dispatchEndpoint(t, 'sharing.set', { enabled: 'yes' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    });
    await expect(dispatchEndpoint(t, 'sharing.set', { enabled: true })).resolves.toEqual({ ok: true, value: { enabled: true } });
    await expect(dispatchEndpoint(t, 'sharing.invite', { ttlSeconds: 0, label: 'Support' })).resolves.toMatchObject({
      ok: true,
      value: { id: 'inv_1', ttlSeconds: 0, label: 'Support' },
    });
    expect(set).toHaveBeenCalledWith(true);
    expect(invite).toHaveBeenCalledWith({ ttlSeconds: 0, label: 'Support' });
  });

  it('maps SharingError to an RPC error with the edge code', async () => {
    const t = target({
      sharingGet: async () => {
        throw new SharingError('HTTP_ERROR', 'Too many requests.', { remoteCode: 'RATE_LIMITED', status: 429 });
      },
    });
    await expect(dispatchEndpoint(t, 'sharing.get', {})).resolves.toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests.' },
    });
  });

  it('requires ids for destructive endpoints', async () => {
    const t = target();
    await expect(dispatchEndpoint(t, 'sharing.decide', { decision: 'approve' })).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } });
    await expect(dispatchEndpoint(t, 'sharing.revokeGuest', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } });
    await expect(dispatchEndpoint(t, 'sharing.revokeAll', {})).resolves.toEqual({ ok: true, value: { revoked: 0 } });
  });
});