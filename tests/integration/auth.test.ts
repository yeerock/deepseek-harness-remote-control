/**
 * Authentication and authorization at the public edge:
 *   no session -> 401, pending/revoked device -> 403, bad pair code -> 403,
 *   anonymous pairing without the owner password -> 401,
 *   cross-site Origin on a state-changing route -> 403.
 *
 * Pairing has two legitimate paths (see apps/edge/src/server.ts handlePair):
 *   - owner session (dashboard), used by startStack();
 *   - anonymous browser + owner password, which yields a device-bound session.
 * Both are exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CookieJar,
  OWNER_PASSWORD,
  browserFetch,
  devicePath,
  pairBrowser,
  rawRequest,
  registerDevice,
  revokeDevice,
  startStack,
  waitFor,
  type LinkStack,
} from '../harness/link.js';

/** GET /pair to obtain the double-submit CSRF cookie, optionally as the owner. */
async function pairForm(edgeUrl: string, code: string, ownerCookie?: string): Promise<CookieJar> {
  const page = await rawRequest(edgeUrl, {
    path: `/pair?code=${encodeURIComponent(code)}`,
    headers: { accept: 'text/html', ...(ownerCookie === undefined ? {} : { cookie: ownerCookie }) },
  });
  const jar = new CookieJar();
  jar.absorb(page.setCookies);
  return jar;
}

function pairPost(edgeUrl: string, options: {
  code: string;
  jar: CookieJar;
  origin?: string;
  password?: string;
}): Promise<Awaited<ReturnType<typeof rawRequest>>> {
  const csrf = options.jar.get('dshrc_csrf') ?? '';
  const form = new URLSearchParams({ code: options.code, csrf });
  if (options.password !== undefined) form.set('password', options.password);
  return rawRequest(edgeUrl, {
    method: 'POST',
    path: '/pair',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: options.origin ?? edgeUrl,
      accept: 'text/html',
      cookie: options.jar.header() ?? '',
      'x-csrf-token': csrf,
    },
    body: form.toString(),
  });
}

async function deviceStatus(edgeUrl: string, secret: string): Promise<{ status?: string }> {
  const response = await rawRequest(edgeUrl, {
    path: '/v1/devices/me',
    headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.bodyText) as { status?: string };
}

describe('edge auth and authorization', () => {
  let stack: LinkStack;

  beforeAll(async () => {
    stack = await startStack();
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('returns 401 for /d/<device>/ without a session', async () => {
    const response = await browserFetch(stack, '/', { cookie: '' });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('returns 401 for a forged session cookie', async () => {
    const response = await browserFetch(stack, '/', { cookie: 'dshrc_session=forged.value' });
    expect(response.status).toBe(401);
  });

  it('returns 404 for an unknown device id with a valid session', async () => {
    const response = await fetch(`${stack.edgeUrl}/d/dev_aaaaaaaaaaaaaaaaaaaa/`, {
      headers: { cookie: stack.owner.cookieHeader ?? '' },
      redirect: 'manual',
    });
    expect(response.status).toBe(404);
  });

  it('returns 403 for a registered but pending device', async () => {
    const pending = await registerDevice(stack.edgeUrl, 'pending-device');
    expect(pending.status).toBe('pending');
    const response = await fetch(`${stack.edgeUrl}/d/${pending.deviceId}/`, {
      headers: { cookie: stack.owner.cookieHeader ?? '' },
      redirect: 'manual',
    });
    expect(response.status).toBe(403);
  });

  it('rejects anonymous pairing without the owner password and leaves the device pending', async () => {
    const device = await registerDevice(stack.edgeUrl, 'anonymous-pair');
    const jar = await pairForm(stack.edgeUrl, device.pairCode);
    const response = await pairPost(stack.edgeUrl, { code: device.pairCode, jar });
    expect(response.status).toBe(401);
    expect((await deviceStatus(stack.edgeUrl, device.deviceSecret)).status).toBe('pending');
  });

  it('rejects a wrong password on the anonymous pairing path', async () => {
    const device = await registerDevice(stack.edgeUrl, 'wrong-password-pair');
    const jar = await pairForm(stack.edgeUrl, device.pairCode);
    const response = await pairPost(stack.edgeUrl, { code: device.pairCode, jar, password: 'not-the-password' });
    expect(response.status).toBe(401);
    expect((await deviceStatus(stack.edgeUrl, device.deviceSecret)).status).toBe('pending');
  });

  it('pairs an anonymous browser with the owner password and issues a device-bound session', async () => {
    const device = await registerDevice(stack.edgeUrl, 'password-pair');
    const paired = await pairBrowser(stack.edgeUrl, device.pairCode, { password: OWNER_PASSWORD });
    expect(paired.status).toBeGreaterThanOrEqual(300);
    expect(paired.status).toBeLessThan(400);
    expect(paired.jar.get('dshrc_session')).toBeDefined();
    expect((await deviceStatus(stack.edgeUrl, device.deviceSecret)).status).toBe('approved');

    // The device session reaches its own mount. No agent is online for this
    // device, so a working session must produce 503, not 401.
    const through = await fetch(`${stack.edgeUrl}${devicePath(device, '/api/status')}`, {
      headers: { cookie: paired.jar.header() ?? '' },
      redirect: 'manual',
    });
    expect(through.status).toBe(503);
    expect(through.headers.get('retry-after')).toBe('5');
  });

  it('returns 403 for a wrong pair code when pairing as the owner', async () => {
    // Owner jar carries both the session cookie and the CSRF cookie, so this
    // isolates the pair-code check from the auth/CSRF checks.
    const jar = stack.owner.jar.clone();
    const response = await pairPost(stack.edgeUrl, { code: 'aaaa-bbbb', jar });
    expect(response.status).toBe(403);
  });

  it('returns 403 for a cross-site Origin even with a valid pair code and owner session', async () => {
    const device = await registerDevice(stack.edgeUrl, 'csrf-device');
    const jar = stack.owner.jar.clone();
    const hostile = await pairPost(stack.edgeUrl, {
      code: device.pairCode,
      jar,
      origin: 'https://evil.example',
    });
    // The hostile POST carried no owner session, so either the CSRF/Origin check
    // or the pairing auth must reject it; it must never approve the device.
    expect(hostile.status).toBe(403);
    expect((await deviceStatus(stack.edgeUrl, device.deviceSecret)).status).toBe('pending');

    const legitimate = await pairBrowser(stack.edgeUrl, device.pairCode, { owner: stack.owner });
    expect(legitimate.status).toBeGreaterThanOrEqual(300);
    expect(legitimate.status).toBeLessThan(400);
    expect((await deviceStatus(stack.edgeUrl, device.deviceSecret)).status).toBe('approved');
  });

  it('returns 403 for /d/<device>/ after the device is revoked', async () => {
    const revoked = await revokeDevice(stack.edgeUrl, stack.owner, stack.deviceId);
    expect(revoked.status).toBeGreaterThanOrEqual(200);
    expect(revoked.status).toBeLessThan(400);

    // The owner session survives revocation, so the device-state check (not
    // session lookup) is what must produce 403 here.
    await waitFor(async () => {
      const response = await fetch(`${stack.edgeUrl}${devicePath(stack, '/')}`, {
        headers: { cookie: stack.owner.cookieHeader ?? '' },
        redirect: 'manual',
      });
      return response.status === 403 ? response : undefined;
    }, { timeoutMs: 5000, intervalMs: 25, label: 'revoked device -> 403' });

    // The agent treats 4003 as terminal: no silent retry loop.
    await waitFor(() => stack.agent.status().state === 'error', {
      timeoutMs: 5000,
      intervalMs: 25,
      label: 'agent reports terminal revocation',
    });
    expect(stack.agent.status().lastError ?? '').toMatch(/revok|4003/i);
  });

  it('invalidates a device-bound session when its device is revoked', async () => {
    const device = await registerDevice(stack.edgeUrl, 'session-revoke');
    const paired = await pairBrowser(stack.edgeUrl, device.pairCode, { password: OWNER_PASSWORD });
    expect(paired.status).toBeGreaterThanOrEqual(300);
    expect(paired.status).toBeLessThan(400);

    await revokeDevice(stack.edgeUrl, stack.owner, device.deviceId);
    const response = await fetch(`${stack.edgeUrl}${devicePath(device, '/api/status')}`, {
      headers: { cookie: paired.jar.header() ?? '' },
      redirect: 'manual',
    });
    expect([401, 403]).toContain(response.status);
  });
});
