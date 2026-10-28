/**
 * Browser regressions that broke v0.2 sharing in real browsers:
 *   1. Chromium sends `Origin: null` on some same-origin form posts. It must be
 *      accepted only when Fetch Metadata says same-origin (or none), and
 *      rejected for cross-site.
 *   2. A guest using the real UI sends `Accept: text/html`; the edge must inject
 *      the fixed Disconnect pill into HTML, while API/asset responses stay
 *      untouched. Owner/device sessions must not get the pill.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CookieJar,
  GUEST_COOKIE,
  browserFetch,
  claimInvite,
  createGuestSession,
  createInvite,
  devicePath,
  disconnectGuest,
  getGuestSessionPage,
  getInvitePage,
  getSharing,
  guestFetch,
  rawRequest,
  registerDevice,
  setSharing,
  startStack,
  type LinkStack,
} from '../harness/link.js';

interface ClaimAttemptOptions {
  origin?: string;
  secFetchSite?: string;
  includeCsrf?: boolean;
  includeCsrfHeader?: boolean;
}

/** POST /i/:token/claim with exact Origin / Fetch-Metadata / CSRF headers. */
async function claimAttempt(
  edgeUrl: string,
  token: string,
  options: ClaimAttemptOptions = {},
): Promise<{ status: number; bodyText: string; jar: CookieJar }> {
  const jar = new CookieJar();
  const page = await getInvitePage(edgeUrl, token);
  jar.absorb(page.setCookies);
  const csrf = jar.get('dshrc_csrf') ?? '';
  const includeCsrf = options.includeCsrf ?? true;
  const headers: Record<string, string> = {
    origin: options.origin ?? edgeUrl,
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    cookie: jar.header() ?? '',
  };
  if (options.secFetchSite !== undefined) headers['sec-fetch-site'] = options.secFetchSite;
  if (includeCsrf && (options.includeCsrfHeader ?? true)) headers['x-csrf-token'] = csrf;
  const body = includeCsrf ? `csrf=${encodeURIComponent(csrf)}` : '';
  const response = await rawRequest(edgeUrl, {
    method: 'POST',
    path: `/i/${encodeURIComponent(token)}/claim`,
    headers,
    body,
  });
  jar.absorb(response.setCookies);
  return { status: response.status, bodyText: response.bodyText, jar };
}

describe('browser origin and guest-pill regressions', () => {
  let stack: LinkStack;
  let secret: string;

  beforeAll(async () => {
    stack = await startStack();
    secret = await stack.deviceSecret();
    expect((await setSharing(stack.edgeUrl, secret, true)).status).toBe(200);
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('accepts Origin: null with Sec-Fetch-Site: same-origin on a guest claim', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'NullOrigin', ttlSeconds: 0 });
    const attempt = await claimAttempt(stack.edgeUrl, invite.token, {
      origin: 'null',
      secFetchSite: 'same-origin',
    });
    expect(attempt.status).toBe(200);
    expect(JSON.parse(attempt.bodyText)).toMatchObject({ status: 'pending', deviceId: stack.deviceId });
    expect(attempt.jar.get('dshrc_claim')).toBeDefined();
  });

  it('rejects Origin: null when Fetch Metadata says cross-site', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'NullCross', ttlSeconds: 0 });
    const attempt = await claimAttempt(stack.edgeUrl, invite.token, {
      origin: 'null',
      secFetchSite: 'cross-site',
    });
    expect(attempt.status).toBe(403);
    expect(attempt.jar.get('dshrc_claim')).toBeUndefined();
    // The claim must not have created an approval the owner could approve.
    expect((await getSharing(stack.edgeUrl, secret)).pendingApprovals.some((entry) => entry.label === 'NullCross')).toBe(false);
  });

  it('rejects an explicit cross-site Origin even with same-origin Fetch Metadata', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'EvilOrigin', ttlSeconds: 0 });
    const attempt = await claimAttempt(stack.edgeUrl, invite.token, {
      origin: 'https://evil.example',
      secFetchSite: 'same-origin',
    });
    expect(attempt.status).toBe(403);
  });

  it('still rejects a same-origin claim with no CSRF token', async () => {
    const invite = await createInvite(stack.edgeUrl, secret, { label: 'NoCsrf', ttlSeconds: 0 });
    const attempt = await claimAttempt(stack.edgeUrl, invite.token, {
      origin: 'null',
      secFetchSite: 'same-origin',
      includeCsrf: false,
    });
    expect(attempt.status).toBe(403);
  });

  it('accepts Origin: null + same-origin on an owner-session form POST (device approve)', async () => {
    const pending = await registerDevice(stack.edgeUrl, 'origin-owner-form');
    const csrf = stack.owner.csrfToken ?? stack.owner.jar.get('dshrc_csrf') ?? '';
    const response = await rawRequest(stack.edgeUrl, {
      method: 'POST',
      path: `/v1/devices/${pending.deviceId}/approve`,
      headers: {
        cookie: stack.owner.cookieHeader ?? '',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(response.status).toBe(303);
    const status = await rawRequest(stack.edgeUrl, {
      path: '/v1/devices/me',
      headers: { authorization: `Bearer ${pending.deviceSecret}`, accept: 'application/json' },
    });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.bodyText)).toMatchObject({ status: 'approved' });
  });

  it('injects the Disconnect pill into guest HTML for browser-like Accept', async () => {
    const guest = await createGuestSession(stack, { label: 'Pill' });
    const response = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/', {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    const html = await response.text();
    expect(html).toContain('id="dshrc-guest-pill"');
    expect(html).toContain('href="/i/session"');
    expect(html).toContain('Remote session');
    expect(html.indexOf('id="dshrc-guest-pill"')).toBe(html.lastIndexOf('id="dshrc-guest-pill"'));

    // The pill's target is a real, working control page.
    const sessionPage = await getGuestSessionPage(stack.edgeUrl, guest.jar);
    expect(sessionPage.response.status).toBe(200);
    expect(sessionPage.response.bodyText).toContain('Disconnect');
    const disconnected = await disconnectGuest(stack.edgeUrl, guest.jar);
    expect(disconnected.status).toBe(303);
    expect(guest.jar.get(GUEST_COOKIE)).toBeUndefined();
    expect((await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/')).status).toBe(401);
  });

  it('marks guest HTML and blocks the host plugin RPC for guests', async () => {
    const guest = await createGuestSession(stack, { label: 'Isolation' });
    const htmlResponse = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/', {
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 Chrome/130' },
    });
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain('globalThis.__DSH_RC_GUEST__=true');
    expect(html).toContain('id="dshrc-guest-pill"');

    const rpc = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/dsh-rc/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack.edgeUrl },
      body: '{}',
    });
    expect(rpc.status).toBe(403);
    expect(await rpc.text()).toContain('guest sessions cannot call the host plugin');
  });

  it('does not inject the pill into guest API, assets, or owner HTML', async () => {
    const guest = await createGuestSession(stack, { label: 'NoPill' });
    const api = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/api/status', {
      headers: { accept: 'application/json' },
    });
    expect(api.status).toBe(200);
    const apiBody = await api.text();
    expect(apiBody).toContain('mock-dsh');
    expect(apiBody).not.toContain('dshrc-guest-pill');

    const asset = await guestFetch(stack.edgeUrl, stack.deviceId, guest.jar, '/assets/app.js', {
      headers: { accept: 'text/html,application/javascript,*/*' },
    });
    expect(asset.status).toBe(200);
    const assetBody = await asset.text();
    expect(assetBody).toContain('mock-dsh');
    expect(assetBody).not.toContain('dshrc-guest-pill');

    const ownerPage = await browserFetch(stack, '/', { headers: { accept: 'text/html' } });
    expect(ownerPage.status).toBe(200);
    const ownerHtml = await ownerPage.text();
    expect(ownerHtml).toContain('mock dsh index');
    expect(ownerHtml).not.toContain('dshrc-guest-pill');
  });
});
