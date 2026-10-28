import { afterEach, describe, expect, it } from 'vitest';
import {
  Jar,
  TEST_PASSWORD,
  extractCsrf,
  http,
  pairDevice,
  provisionDevice,
  registerDevice,
  setupOwner,
  startEdge,
  type TestEdge,
} from './helpers.js';

const edges: TestEdge[] = [];

async function boot(): Promise<TestEdge> {
  const edge = await startEdge();
  edges.push(edge);
  return edge;
}

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

async function deviceStatus(base: string, device: { deviceId: string; deviceSecret: string }): Promise<string> {
  const response = await http(base, '/v1/devices/me', { headers: { authorization: `Bearer ${device.deviceSecret}` } });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string };
  return body.status;
}

describe('pairing', () => {
  it('does not treat the pair code as a bearer credential', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    const jar = new Jar();
    const page = await http(edge.base, `/pair?code=${device.pairCode}`, { jar });
    const html = await page.text();
    // Anonymous visitors see the owner-password field and a login link.
    expect(html).toContain('name="password"');
    expect(html).toContain('/login?next=');
    const csrf = extractCsrf(html);

    const anonymous = await http(edge.base, '/pair', {
      method: 'POST',
      jar,
      form: { csrf, code: device.pairCode },
      headers: { origin: edge.base },
    });
    expect(anonymous.status).toBe(401);
    expect(await deviceStatus(edge.base, device)).toBe('pending');

    const wrongPassword = await http(edge.base, '/pair', {
      method: 'POST',
      jar,
      form: { csrf, code: device.pairCode, password: 'wrong-password' },
      headers: { origin: edge.base },
    });
    expect(wrongPassword.status).toBe(401);
    expect(await deviceStatus(edge.base, device)).toBe('pending');
  });

  it('redeems with the owner session and grants that browser device access', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    const paired = await pairDevice(edge.base, device.pairCode, { ownerJar: owner.jar });
    expect(paired.response.status).toBe(303);
    expect(paired.response.headers.get('location')).toBe(`/d/${device.deviceId}/`);
    expect(await deviceStatus(edge.base, device)).toBe('approved');

    const offline = await http(edge.base, `/d/${device.deviceId}/`, { jar: owner.jar, headers: { accept: 'text/html' } });
    expect(offline.status).toBe(503);
    expect(offline.headers.get('retry-after')).toBe('5');
  });

  it('redeems with the owner password on a fresh browser and issues a device session', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    const paired = await pairDevice(edge.base, device.pairCode, { password: TEST_PASSWORD });
    expect(paired.response.status).toBe(303);
    expect(paired.jar.get('dshrc_session')).toBeTruthy();
    expect(await deviceStatus(edge.base, device)).toBe('approved');

    // Device-bound session: not an owner session, but it can open its device.
    const dashboard = await http(edge.base, '/', { jar: paired.jar });
    expect(dashboard.status).toBe(403);
    const devicePage = await http(edge.base, `/d/${device.deviceId}/`, { jar: paired.jar, headers: { accept: 'text/html' } });
    expect(devicePage.status).toBe(503);
  });

  it('reports a wrong or reused code as 403 and never approves the device', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    const wrong = await pairDevice(edge.base, 'zzzz-zzzz', { ownerJar: owner.jar });
    expect(wrong.response.status).toBe(403);
    expect(await deviceStatus(edge.base, device)).toBe('pending');

    const first = await pairDevice(edge.base, device.pairCode, { ownerJar: owner.jar });
    expect(first.response.status).toBe(303);
    const second = await pairDevice(edge.base, device.pairCode, { ownerJar: owner.jar });
    expect(second.response.status).toBe(403);
  });

  it('expires pair codes after their TTL', async () => {
    const edge = await startEdge({ pairCodeTtlMs: 40 });
    edges.push(edge);
    const owner = await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const paired = await pairDevice(edge.base, device.pairCode, { ownerJar: owner.jar });
    expect(paired.response.status).toBe(403);
    expect(await deviceStatus(edge.base, device)).toBe('pending');
  });
});

describe('device lifecycle', () => {
  it('registers, reports itself and is revoked by the owner', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    expect(device.deviceId).toMatch(/^dev_[a-z0-9]{16,64}$/);

    const me = await http(edge.base, '/v1/devices/me', { headers: { authorization: `Bearer ${device.deviceSecret}` } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as Record<string, unknown>;
    expect(body['deviceId']).toBe(device.deviceId);
    expect(body['status']).toBe('approved');
    expect(body['online']).toBe(false);

    const dashboard = await http(edge.base, '/', { jar: owner.jar });
    expect(dashboard.status).toBe(200);

    const revoke = await http(edge.base, `/v1/devices/${device.deviceId}/revoke`, {
      method: 'POST',
      jar: owner.jar,
      headers: { origin: edge.base, 'x-csrf-token': owner.jar.get('dshrc_csrf') ?? '', accept: 'application/json' },
    });
    expect(revoke.status).toBe(200);
    const revokedBody = (await revoke.json()) as { ok: boolean };
    expect(revokedBody.ok).toBe(true);

    const revoked = await http(edge.base, '/v1/devices/me', { headers: { authorization: `Bearer ${device.deviceSecret}` } });
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ error: 'DEVICE_REVOKED' });

    const ownerView = await http(edge.base, `/d/${device.deviceId}/`, { jar: owner.jar });
    expect(ownerView.status).toBe(403);
  });

  it('rejects a made-up bearer secret and an invalid registration body', async () => {
    const edge = await boot();
    const badMe = await http(edge.base, '/v1/devices/me', { headers: { authorization: 'Bearer nope' } });
    expect(badMe.status).toBe(401);

    const badRegister = await http(edge.base, '/v1/devices/register', { method: 'POST', json: { name: '' } });
    expect(badRegister.status).toBe(400);
  });

  it('refuses approve/revoke without an owner session or CSRF token', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    const anonymous = await http(edge.base, `/v1/devices/${device.deviceId}/approve`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(anonymous.status).toBe(401);

    const noCsrf = await http(edge.base, `/v1/devices/${device.deviceId}/approve`, {
      method: 'POST',
      jar: owner.jar,
      headers: { accept: 'application/json', origin: edge.base },
    });
    expect(noCsrf.status).toBe(403);

    const approved = await http(edge.base, `/v1/devices/${device.deviceId}/approve`, {
      method: 'POST',
      jar: owner.jar,
      headers: { accept: 'application/json', origin: edge.base, 'x-csrf-token': owner.jar.get('dshrc_csrf') ?? '' },
    });
    expect(approved.status).toBe(200);
    expect(await deviceStatus(edge.base, device)).toBe('approved');
  });
});