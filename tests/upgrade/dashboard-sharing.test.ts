/**
 * Owner-dashboard sharing E2E (v0.2): log in through /login, toggle sharing,
 * create a Never invite from the dashboard, claim as a guest, approve from the
 * dashboard, use /d/ + WebSocket as the guest, then Revoke all from the
 * dashboard and watch the socket close.
 *
 * Exercises the server-rendered owner routes added in task-10 — no device-secret
 * API calls are used for the owner actions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  CookieJar,
  OWNER_PASSWORD,
  claimInvite,
  closeWebSocket,
  devicePath,
  getSharing,
  guestFetch,
  nextWsMessage,
  rawRequest,
  startStack,
  waitFor,
  waitForGuestSession,
  waitForWsClose,
  wsOpen,
  type GuestSession,
  type LinkStack,
} from '../harness/link.js';

interface OwnerBrowser {
  jar: CookieJar;
  csrf: string;
}

function extractCsrf(html: string): string | undefined {
  return /name="csrf"\s+value="([^"]+)"/i.exec(html)?.[1];
}

async function ownerLogin(stack: LinkStack): Promise<OwnerBrowser> {
  const jar = new CookieJar();
  const loginPage = await rawRequest(stack.edgeUrl, { path: '/login', headers: { accept: 'text/html' } });
  jar.absorb(loginPage.setCookies);
  const loginCsrf = jar.get('dshrc_csrf') ?? extractCsrf(loginPage.bodyText) ?? '';
  const login = await rawRequest(stack.edgeUrl, {
    method: 'POST',
    path: '/login',
    headers: {
      cookie: jar.header() ?? '',
      origin: stack.edgeUrl,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    },
    body: `csrf=${encodeURIComponent(loginCsrf)}&password=${encodeURIComponent(OWNER_PASSWORD)}`,
  });
  expect(login.status).toBe(303);
  expect(login.headers['location']).toBe('/');
  jar.absorb(login.setCookies);
  const dashboard = await rawRequest(stack.edgeUrl, {
    path: '/',
    headers: { cookie: jar.header() ?? '', accept: 'text/html' },
  });
  expect(dashboard.status).toBe(200);
  const csrf = extractCsrf(dashboard.bodyText) ?? jar.get('dshrc_csrf') ?? '';
  expect(csrf).not.toBe('');
  return { jar, csrf };
}

async function dashboardGet(browser: OwnerBrowser, edgeUrl: string): Promise<{ status: number; body: string }> {
  const response = await rawRequest(edgeUrl, {
    path: '/',
    headers: { cookie: browser.jar.header() ?? '', accept: 'text/html' },
  });
  return { status: response.status, body: response.bodyText };
}

async function dashboardPost(
  browser: OwnerBrowser,
  edgeUrl: string,
  path: string,
  fields: Record<string, string>,
): Promise<Awaited<ReturnType<typeof rawRequest>>> {
  const form = new URLSearchParams({ ...fields, csrf: browser.csrf });
  return await rawRequest(edgeUrl, {
    method: 'POST',
    path,
    headers: {
      cookie: browser.jar.header() ?? '',
      origin: edgeUrl,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    },
    body: form.toString(),
  });
}

async function openGuestWs(stack: LinkStack, jar: CookieJar): Promise<WebSocket> {
  const socket = new WebSocket(
    `${stack.edgeUrl.replace(/^http/, 'ws')}${devicePath(stack, '/api/remote.mux')}`,
    { headers: { cookie: jar.header() ?? '' } },
  );
  await wsOpen(socket, 10_000);
  return socket;
}

async function echo(socket: WebSocket, message: string): Promise<string> {
  const received = nextWsMessage(socket, 5000);
  socket.send(message);
  return (await received).data.toString('utf8');
}

describe('owner-dashboard sharing E2E', () => {
  let stack: LinkStack;
  let browser: OwnerBrowser;
  let token: string;
  let guest: GuestSession;

  beforeAll(async () => {
    stack = await startStack();
    // No owner session -> dashboard redirects to the login form.
    const anonymous = await rawRequest(stack.edgeUrl, { path: '/', headers: { accept: 'text/html' } });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers['location']).toBe('/login');
    browser = await ownerLogin(stack);
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('enables sharing from the dashboard and shows the owner warnings', async () => {
    const before = await dashboardGet(browser, stack.edgeUrl);
    expect(before.body).toContain('Share this Harness');
    expect(before.body).toContain('Guest sessions never expire');
    expect(before.body).toContain('Multiple guests can control this desktop');

    const toggled = await dashboardPost(browser, stack.edgeUrl, `/v1/devices/${stack.deviceId}/sharing`, { enabled: '1' });
    expect(toggled.status).toBe(303);
    expect(toggled.headers['location']).toBe('/');

    const after = await dashboardGet(browser, stack.edgeUrl);
    expect(after.body).toContain('sharing on');
    expect((await getSharing(stack.edgeUrl, await stack.deviceSecret())).enabled).toBe(true);
  });

  it('creates a Never invite from the dashboard and renders the one-time URL', async () => {
    const created = await dashboardPost(browser, stack.edgeUrl, `/v1/devices/${stack.deviceId}/invites`, {
      label: 'Dashboard Guest',
      ttlSeconds: '0',
      maxUses: '1',
    });
    expect(created.status).toBe(200);
    expect(created.bodyText).toContain('Invite created');
    expect(created.bodyText).toContain('Never expires');
    const match = /\/i\/([A-Za-z0-9_-]{43})/.exec(created.bodyText);
    expect(match).not.toBeNull();
    token = match![1]!;

    // The token must not be available from the dashboard afterwards.
    const dashboard = await dashboardGet(browser, stack.edgeUrl);
    expect(dashboard.body).toContain('Outstanding invites');
    expect(dashboard.body).toContain('Dashboard Guest');
    expect(dashboard.body).toContain('Never');
    expect(dashboard.body).not.toContain(token);
  });

  it('shows a guest claim as a pending approval and approves it from the dashboard', async () => {
    const claim = await claimInvite(stack.edgeUrl, token);
    expect(claim.status).toBe(200);
    expect(claim.json).toMatchObject({ status: 'pending', deviceId: stack.deviceId });

    const pending = await dashboardGet(browser, stack.edgeUrl);
    expect(pending.body).toContain('Dashboard Guest');
    expect(pending.body).toContain('127.0.0.1');
    const approvalId = /\/approvals\/(apr_[a-z0-9]+)/i.exec(pending.body)?.[1];
    expect(approvalId).toBeDefined();

    const approved = await dashboardPost(
      browser,
      stack.edgeUrl,
      `/v1/devices/${stack.deviceId}/approvals/${approvalId}`,
      { decision: 'approve' },
    );
    expect(approved.status).toBe(303);

    const status = await waitForGuestSession(stack.edgeUrl, token, claim.jar);
    expect(status.state).toBe('approved');
    expect(claim.jar.get('dshrc_guest')).toBeDefined();
    guest = {
      label: 'Dashboard Guest',
      token,
      inviteId: '',
      approvalId,
      jar: claim.jar,
      status,
      sessionId: (status.json as { sessionId?: string } | undefined)?.sessionId,
    };

    const active = await dashboardGet(browser, stack.edgeUrl);
    expect(active.body).toContain('Active guests');
    expect(active.body).toContain('Dashboard Guest');
  });

  it('serves /d/ and a WebSocket to the dashboard-approved guest', async () => {
    const page = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('mock dsh index');

    const socket = await openGuestWs(stack, guest.jar);
    try {
      expect(await echo(socket, 'dashboard-guest')).toBe('dashboard-guest');
    } finally {
      await closeWebSocket(socket);
    }
  });

  it('Revoke all from the dashboard closes the guest WebSocket and invalidates the session', async () => {
    const socket = await openGuestWs(stack, guest.jar);
    expect(await echo(socket, 'before-revoke-all')).toBe('before-revoke-all');
    const closed = waitForWsClose(socket, 5000);

    const revoked = await dashboardPost(browser, stack.edgeUrl, `/v1/devices/${stack.deviceId}/guests/revoke-all`, {});
    expect(revoked.status).toBe(303);
    expect(revoked.headers['location']).toBe('/');
    expect((await closed).code).toBe(1008);
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/')).status).toBe(401);

    await waitFor(async () => {
      const dashboard = await dashboardGet(browser, stack.edgeUrl);
      return dashboard.body.includes('No active guests.');
    }, { timeoutMs: 5000, intervalMs: 25, label: 'dashboard shows no active guests' });
  });
});
