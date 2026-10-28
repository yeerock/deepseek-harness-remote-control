import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Stream } from '@dsh-rc/mux';
import { EdgeDatabase } from '../src/db.js';
import {
  Jar,
  TEST_PASSWORD,
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

/* ------------------------------ sharing helpers ---------------------------- */

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
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function enableSharing(base: string, device: RegisteredDevice): Promise<void> {
  expect((await deviceApi(base, device, 'PUT', '/v1/devices/me/sharing', { enabled: true })).status).toBe(200);
}

async function createInvite(base: string, device: RegisteredDevice, label: string): Promise<{ token: string; url: string }> {
  const response = await deviceApi(base, device, 'POST', '/v1/devices/me/invites', { label, ttlSeconds: 0, maxUses: 1 });
  expect(response.status).toBe(200);
  return response.body as unknown as { token: string; url: string };
}

async function guestSessionFor(
  base: string,
  device: RegisteredDevice,
  token: string,
  label: string,
): Promise<{ jar: Jar; sessionId: string }> {
  const jar = new Jar();
  const page = await http(base, `/i/${token}`, { jar });
  expect(page.status).toBe(200);
  const csrf = extractCsrf(await page.text());
  const claim = await http(base, `/i/${token}/claim`, {
    method: 'POST',
    jar,
    form: { csrf },
    headers: { origin: base, accept: 'application/json' },
  });
  expect(claim.status).toBe(200);
  const { approvalId } = (await claim.json()) as { approvalId: string };
  const decided = await deviceApi(base, device, 'POST', `/v1/devices/me/approvals/${approvalId}`, { decision: 'approve' });
  expect(decided.status).toBe(200);
  const status = await http(base, `/i/${token}/status`, { jar });
  expect(status.status).toBe(200);
  const body = (await status.json()) as { status: string; sessionId: string };
  expect(body.status).toBe('approved');
  expect(body.sessionId).toBe(decided.body['sessionId']);
  return { jar, sessionId: body.sessionId };
}

function respondHtml(html: string): (stream: Stream) => void {
  return (stream) => {
    void (async () => {
      for await (const _chunk of stream.body()) {
        /* drain */
      }
      const body = Buffer.from(html);
      stream.sendHead({
        status: 200,
        headers: [
          ['content-type', 'text/html; charset=utf-8'],
          ['content-length', String(body.byteLength)],
        ],
      });
      await stream.write(body);
      await stream.end();
    })();
  };
}

function respondGzipHtml(html: string): (stream: Stream) => void {
  return (stream) => {
    void (async () => {
      for await (const _chunk of stream.body()) {
        /* drain */
      }
      const body = gzipSync(Buffer.from(html));
      stream.sendHead({
        status: 200,
        headers: [
          ['content-type', 'text/html; charset=utf-8'],
          ['content-encoding', 'gzip'],
          ['content-length', String(body.byteLength)],
        ],
      });
      await stream.write(body);
      await stream.end();
    })();
  };
}

/* ---------------------------------- tests ---------------------------------- */

describe('origin handling', () => {
  async function loginAttempt(
    edge: TestEdge,
    origin: string | undefined,
    fetchSite: string | undefined,
  ): Promise<Response> {
    const jar = new Jar();
    const page = await http(edge.base, '/login', { jar });
    const csrf = extractCsrf(await page.text());
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers['origin'] = origin;
    if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite;
    return http(edge.base, '/login', {
      method: 'POST',
      jar,
      form: { csrf, password: TEST_PASSWORD },
      headers,
    });
  }

  it('accepts Origin: null with Sec-Fetch-Site: same-origin on a form POST', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    const response = await loginAttempt(edge, 'null', 'same-origin');
    expect(response.status).toBe(303);
  });

  it('rejects Origin: null without same-origin Fetch Metadata', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    expect((await loginAttempt(edge, 'null', 'cross-site')).status).toBe(403);
    expect((await loginAttempt(edge, 'null', undefined)).status).toBe(403);
  });

  it('rejects an explicit cross-site Origin even with same-origin Fetch Metadata', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    expect((await loginAttempt(edge, 'https://evil.example', 'same-origin')).status).toBe(403);
  });

  it('still requires the CSRF token', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    const jar = new Jar();
    await http(edge.base, '/login', { jar });
    const response = await http(edge.base, '/login', {
      method: 'POST',
      jar,
      form: { password: TEST_PASSWORD },
      headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status).toBe(403);
  });
});

describe('guest HTML pill', () => {
  it('injects the pill into gzip-compressed guest HTML but never owner HTML', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await enableSharing(edge.base, device);
    const invite = await createInvite(edge.base, device, 'Pill');
    const guest = await guestSessionFor(edge.base, device, invite.token, 'Pill');

    const html = '<html><body>Harness</body></html>';
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: respondGzipHtml(html),
    });
    try {
      const guestResponse = await http(edge.base, `/d/${device.deviceId}/`, {
        jar: guest.jar,
        headers: { accept: 'text/html', 'accept-encoding': 'gzip' },
      });
      expect(guestResponse.status).toBe(200);
      expect(guestResponse.headers.get('content-encoding')).toBeNull();
      const guestBody = await guestResponse.text();
      expect(guestBody).toContain('id="dshrc-guest-pill"');
      expect(guestBody).toContain('href="/i/session"');
      expect(guestBody).toContain('Harness');

      const ownerResponse = await http(edge.base, `/d/${device.deviceId}/`, {
        jar: owner.jar,
        headers: { accept: 'text/html', 'accept-encoding': 'gzip' },
      });
      expect(ownerResponse.status).toBe(200);
      const ownerBody = await ownerResponse.text();
      expect(ownerBody).not.toContain('dshrc-guest-pill');
      expect(ownerBody).toContain('Harness');
    } finally {
      await agent.close();
    }
  });
});

describe('dsh-rc-edge-passwd', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(new URL('../src/passwd.ts', import.meta.url))), '..', '..', '..');
  const passwdEntry = fileURLToPath(new URL('../src/passwd.ts', import.meta.url));

  function runPasswd(dataDir: string, password: string): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ['--import', 'tsx', passwdEntry, '--data-dir', dataDir], {
      cwd: repoRoot,
      env: { ...process.env, DSHRC_NEW_PASSWORD: password },
      encoding: 'utf8',
    });
  }

  it('rotates a copied edge DB and rejects short passwords / a missing owner', async () => {
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'dshrc-passwd-src-'));
    const copyDir = await mkdtemp(path.join(tmpdir(), 'dshrc-passwd-copy-'));
    const noOwnerDir = await mkdtemp(path.join(tmpdir(), 'dshrc-passwd-empty-'));
    cleanupDirs.push(sourceDir, copyDir, noOwnerDir);

    const source = await startEdgeIn(sourceDir);
    await setupOwner(source.base, { password: TEST_PASSWORD });
    await source.close();
    await cp(sourceDir, copyDir, { recursive: true });

    const short = runPasswd(copyDir, 'short');
    expect(short.status).toBe(2);

    const newPassword = 'new-password-rotated-123';
    const rotated = runPasswd(copyDir, newPassword);
    expect(rotated.status).toBe(0);

    // Proper login attempts (fresh CSRF per attempt) against the rotated DB.
    const verify = await startEdgeIn(copyDir);
    try {
      const oldForm = new Jar();
      const oldPage = await http(verify.base, '/login', { jar: oldForm });
      const oldCsrf = extractCsrf(await oldPage.text());
      const oldAttempt = await http(verify.base, '/login', {
        method: 'POST',
        jar: oldForm,
        form: { csrf: oldCsrf, password: TEST_PASSWORD },
        headers: { origin: verify.base },
      });
      expect(oldAttempt.status).toBe(403);

      const newForm = new Jar();
      const newPage = await http(verify.base, '/login', { jar: newForm });
      const newCsrf = extractCsrf(await newPage.text());
      const newAttempt = await http(verify.base, '/login', {
        method: 'POST',
        jar: newForm,
        form: { csrf: newCsrf, password: newPassword },
        headers: { origin: verify.base },
      });
      expect(newAttempt.status).toBe(303);
    } finally {
      await verify.close();
    }

    const empty = new EdgeDatabase(noOwnerDir);
    empty.close();
    expect(runPasswd(noOwnerDir, newPassword).status).toBe(1);
  });
});

describe('owner dashboard sharing flow', () => {
  it('toggles sharing, renders one-time invite URL, approves, lists and revokes a guest', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);

    const dashboard = await http(edge.base, '/', { jar: owner.jar });
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('Share this Harness');
    const csrf = extractCsrf(dashboardHtml);

    const enabled = await http(edge.base, `/v1/devices/${device.deviceId}/sharing`, {
      method: 'POST',
      jar: owner.jar,
      form: { csrf, enabled: '1' },
      headers: { origin: edge.base },
    });
    expect(enabled.status).toBe(303);

    const enabledDashboard = await http(edge.base, '/', { jar: owner.jar });
    const enabledHtml = await enabledDashboard.text();
    expect(enabledHtml).toContain('sharing on');
    expect(enabledHtml).toContain('Create invite');
    expect(enabledHtml).toContain('Never');
    const ownerCsrf = extractCsrf(enabledHtml);

    // The invite URL must be rendered by the POST response itself, never in a redirect.
    const created = await http(edge.base, `/v1/devices/${device.deviceId}/invites`, {
      method: 'POST',
      jar: owner.jar,
      form: { csrf: ownerCsrf, label: 'Dashboard Guest', ttlSeconds: '0', maxUses: '1' },
      headers: { origin: edge.base },
    });
    expect(created.status).toBe(200);
    expect(created.headers.get('location')).toBeNull();
    const createdHtml = await created.text();
    expect(createdHtml).toContain('Invite created');
    const inviteMatch = new RegExp(`${edge.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i/([A-Za-z0-9_-]{16,})`).exec(createdHtml);
    expect(inviteMatch).not.toBeNull();
    const token = inviteMatch?.[1] ?? '';

    const guest = new Jar();
    const invitePage = await http(edge.base, `/i/${token}`, { jar: guest });
    const inviteCsrf = extractCsrf(await invitePage.text());
    const claim = await http(edge.base, `/i/${token}/claim`, {
      method: 'POST',
      jar: guest,
      form: { csrf: inviteCsrf },
      headers: { origin: edge.base, accept: 'application/json' },
    });
    expect(claim.status).toBe(200);

    const pendingDashboard = await http(edge.base, '/', { jar: owner.jar });
    const pendingHtml = await pendingDashboard.text();
    expect(pendingHtml).toContain('Waiting for approval');
    expect(pendingHtml).toContain('Dashboard Guest');
    const approvalMatch = new RegExp(`/v1/devices/${device.deviceId}/approvals/([^"/]+)`).exec(pendingHtml);
    expect(approvalMatch).not.toBeNull();
    const approvalId = approvalMatch?.[1] ?? '';

    const approved = await http(edge.base, `/v1/devices/${device.deviceId}/approvals/${approvalId}`, {
      method: 'POST',
      jar: owner.jar,
      form: { csrf: ownerCsrf, decision: 'approve' },
      headers: { origin: edge.base },
    });
    expect(approved.status).toBe(303);

    const status = await http(edge.base, `/i/${token}/status`, { jar: guest });
    expect(await status.json()).toMatchObject({ status: 'approved' });

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: respondHtml('<html><body>DSH</body></html>'),
    });
    try {
      const guestPage = await http(edge.base, `/d/${device.deviceId}/`, { jar: guest, headers: { accept: 'text/html' } });
      expect(guestPage.status).toBe(200);

      const activeDashboard = await http(edge.base, '/', { jar: owner.jar });
      const activeHtml = await activeDashboard.text();
      expect(activeHtml).toContain('Active guests');
      expect(activeHtml).toContain('Dashboard Guest');
      expect(activeHtml).toContain('Revoke all guests');
      const sessionMatch = new RegExp(`/v1/devices/${device.deviceId}/guests/(sess_[A-Za-z0-9_-]+)/revoke`).exec(activeHtml);
      expect(sessionMatch).not.toBeNull();
      const sessionId = sessionMatch?.[1] ?? '';
      expect(edge.edge.db.getSession(sessionId)?.kind).toBe('guest');

      const revoked = await http(edge.base, `/v1/devices/${device.deviceId}/guests/${sessionId}/revoke`, {
        method: 'POST',
        jar: owner.jar,
        form: { csrf: ownerCsrf },
        headers: { origin: edge.base },
      });
      expect(revoked.status).toBe(303);
      expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: guest })).status).toBe(401);
    } finally {
      await agent.close();
    }
  });

  it('revokes every guest from the dashboard Revoke all form', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await enableSharing(edge.base, device);
    const first = await createInvite(edge.base, device, 'First');
    const second = await createInvite(edge.base, device, 'Second');
    const guestA = await guestSessionFor(edge.base, device, first.token, 'First');
    const guestB = await guestSessionFor(edge.base, device, second.token, 'Second');

    const dashboard = await http(edge.base, '/', { jar: owner.jar });
    const csrf = extractCsrf(await dashboard.text());
    const revoked = await http(edge.base, `/v1/devices/${device.deviceId}/guests/revoke-all`, {
      method: 'POST',
      jar: owner.jar,
      form: { csrf },
      headers: { origin: edge.base },
    });
    expect(revoked.status).toBe(303);
    expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: guestA.jar })).status).toBe(401);
    expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: guestB.jar })).status).toBe(401);
  });

  it('closes a guest WebSocket when the owner turns sharing off from the dashboard', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    await enableSharing(edge.base, device);
    const invite = await createInvite(edge.base, device, 'ToggleOff');
    const guest = await guestSessionFor(edge.base, device, invite.token, 'ToggleOff');

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
      const dashboard = await http(edge.base, '/', { jar: owner.jar });
      const csrf = extractCsrf(await dashboard.text());
      const disabled = await http(edge.base, `/v1/devices/${device.deviceId}/sharing`, {
        method: 'POST',
        jar: owner.jar,
        form: { csrf, enabled: '0' },
        headers: { origin: edge.base },
      });
      expect(disabled.status).toBe(303);
      expect(await closed).not.toBe(-1);
      expect((await http(edge.base, `/d/${device.deviceId}/`, { jar: guest.jar })).status).toBe(401);
    } finally {
      try {
        browser.terminate();
      } catch {
        /* already gone */
      }
      await agent.close();
    }
  });
});