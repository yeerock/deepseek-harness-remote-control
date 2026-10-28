import { afterEach, describe, expect, it } from 'vitest';
import { Jar, TEST_PASSWORD, extractCsrf, http, loginOwner, setupOwner, startEdge, type TestEdge } from './helpers.js';

const edges: TestEdge[] = [];

async function boot(overrides: Parameters<typeof startEdge>[0] = {}): Promise<TestEdge> {
  const edge = await startEdge(overrides);
  edges.push(edge);
  return edge;
}

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

describe('first-run setup', () => {
  it('requires the setup code, a CSRF token and a same-origin request', async () => {
    const edge = await boot();
    const jar = new Jar();
    const page = await http(edge.base, '/setup', { jar });
    expect(page.status).toBe(200);
    const html = await page.text();
    const csrf = extractCsrf(html);
    expect(jar.get('dshlink_csrf')).toBeTruthy();

    const missingCsrf = await http(edge.base, '/setup', {
      method: 'POST',
      jar,
      form: { code: edge.setupCode },
      headers: { origin: edge.base },
    });
    expect(missingCsrf.status).toBe(403);

    const crossSite = await http(edge.base, '/setup', {
      method: 'POST',
      jar,
      form: { csrf, code: edge.setupCode },
      headers: { origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(403);

    const wrongCode = await http(edge.base, '/setup', {
      method: 'POST',
      jar,
      form: { csrf, code: 'not-the-code' },
      headers: { origin: edge.base },
    });
    expect(wrongCode.status).toBe(403);

    const ok = await http(edge.base, '/setup', {
      method: 'POST',
      jar,
      form: { csrf, code: edge.setupCode, password: TEST_PASSWORD },
      headers: { origin: edge.base },
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    const sessionCookie = jar.get('dshlink_session');
    expect(sessionCookie).toBeTruthy();
    // HMAC-signed payload: base64url(payload).base64url(signature).
    expect(sessionCookie).toContain('.');

    const dashboard = await http(edge.base, '/', { jar });
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('Dashboard');
    expect(dashboardHtml).toContain('owner-setup');

    const again = await http(edge.base, '/setup', { jar });
    expect(again.status).toBe(403);
  });

  it('rejects a session cookie whose signature was tampered with', async () => {
    const edge = await boot();
    const { jar } = await setupOwner(edge.base);
    const cookie = jar.get('dshlink_session');
    expect(cookie).toBeTruthy();
    const tampered = `${(cookie ?? '').slice(0, -2)}aa`;

    const response = await fetch(`${edge.base}/`, {
      headers: { cookie: `dshlink_session=${tampered}` },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('logout invalidates the session row and clears the cookie', async () => {
    const edge = await boot();
    const { jar } = await setupOwner(edge.base);
    const dashboard = await http(edge.base, '/', { jar });
    expect(dashboard.status).toBe(200);
    const csrf = jar.get('dshlink_csrf');

    const logout = await http(edge.base, '/logout', {
      method: 'POST',
      jar,
      form: { csrf: csrf ?? '' },
      headers: { origin: edge.base },
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('location')).toBe('/login');

    const after = await http(edge.base, '/', { jar });
    expect(after.status).toBe(303);
    expect(after.headers.get('location')).toBe('/login');
  });
});

describe('owner login', () => {
  it('rejects a wrong password and accepts the configured one', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    const jar = new Jar();
    const page = await http(edge.base, '/login', { jar });
    expect(page.status).toBe(200);
    const csrf = extractCsrf(await page.text());

    const wrong = await http(edge.base, '/login', {
      method: 'POST',
      jar,
      form: { csrf, password: 'definitely-wrong' },
      headers: { origin: edge.base },
    });
    expect(wrong.status).toBe(403);

    const good = await loginOwner(edge.base);
    expect(good.response.status).toBe(303);
    expect((await http(edge.base, '/', { jar: good.jar })).status).toBe(200);
  });

  it('honours next= for the post-login redirect but refuses absolute URLs', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    const jar = new Jar();
    const page = await http(edge.base, '/login?next=%2Fpair%3Fcode%3Dabcd-efgh', { jar });
    const csrf = extractCsrf(await page.text());
    const redirected = await http(edge.base, '/login', {
      method: 'POST',
      jar,
      form: { csrf, password: TEST_PASSWORD, next: '/pair?code=abcd-efgh' },
      headers: { origin: edge.base },
    });
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get('location')).toBe('/pair?code=abcd-efgh');

    const evil = await http(edge.base, '/login', {
      method: 'POST',
      jar,
      form: { csrf, password: TEST_PASSWORD, next: 'https://evil.example/' },
      headers: { origin: edge.base },
    });
    expect(evil.status).toBe(303);
    expect(evil.headers.get('location')).toBe('/');
  });
});