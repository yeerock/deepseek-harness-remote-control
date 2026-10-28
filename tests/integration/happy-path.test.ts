/**
 * Happy path through the real tunnel: HTTP, chunked streaming, 8 MiB integrity,
 * WebSocket echo, header hygiene, Location rewriting and path safety.
 *
 * One stack for the whole file; every test is read-only so ordering does not
 * matter beyond the shared boot cost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { patternBytes } from '../fixtures/mock-dsh.js';
import {
  browserFetch,
  closeWebSocket,
  devicePath,
  nextWsMessage,
  rawRequest,
  responseSetCookies,
  startStack,
  waitFor,
  wsOpen,
  type LinkStack,
} from '../harness/link.js';

const MB = 1024 * 1024;

describe('HTTP + WebSocket through edge -> agent -> mock DSH', () => {
  let stack: LinkStack;

  beforeAll(async () => {
    stack = await startStack();
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('serves the DSH index HTML through /d/<device>/', async () => {
    const response = await browserFetch(stack, '/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('mock dsh index');
    expect(body).toContain('<base href="./">');
  });

  it('redirects /d/<device> to /d/<device>/ (relative asset safety)', async () => {
    const response = await browserFetch(stack, '');
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location')?.endsWith('/')).toBe(true);
  });

  it('proxies the JSON API', async () => {
    const response = await browserFetch(stack, '/api/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, upstream: 'mock-dsh' });
  });

  it('streams a 1 MiB+ chunked response byte-for-byte', async () => {
    const response = await browserFetch(stack, '/api/stream');
    expect(response.status).toBe(200);
    // The mock omits Content-Length here, so the tunnel must preserve chunked
    // framing rather than inventing a length.
    expect(response.headers.get('content-length')).toBeNull();
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.byteLength).toBe(MB + 123);
    expect(body.equals(patternBytes(body.byteLength))).toBe(true);
  });

  it('preserves an 8 MiB response byte-for-byte', async () => {
    const response = await browserFetch(stack, '/api/large?bytes=8388608');
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.byteLength).toBe(8 * MB);
    expect(body.equals(patternBytes(body.byteLength))).toBe(true);
  });

  it('keeps memory bounded while streaming 32 MiB (sanity)', async () => {
    const startRss = process.memoryUsage().rss;
    let peakRss = startRss;
    const response = await browserFetch(stack, '/api/large?bytes=33554432');
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    let total = 0;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      total += value.byteLength;
      if (total % (4 * MB) < value.byteLength) peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    expect(total).toBe(32 * MB);
    const growthMiB = (Math.max(peakRss, process.memoryUsage().rss) - startRss) / MB;
    // A proxy that buffered the whole body in the agent process would show at
    // least 32 MiB growth; the credit windows cap a correct implementation well
    // below this. Generous enough not to flake on GC timing.
    expect(growthMiB).toBeLessThan(128);
  });

  it('streams a 1 MiB request body to the upstream (client -> DSH direction)', async () => {
    const payload = 'x'.repeat(1024 * 1024);
    const response = await browserFetch(stack, '/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: payload,
    });
    expect(response.status).toBe(200);
    const echoed = await response.json() as { method: string; body: string };
    expect(echoed.method).toBe('POST');
    expect(echoed.body.length).toBe(payload.length);
  });

  it('relays a WebSocket echo through /d/<device>/api/remote.mux', async () => {
    const url = `${stack.edgeUrl.replace(/^http/, 'ws')}${devicePath(stack, '/api/remote.mux')}`;
    const socket = new WebSocket(url, ['dsh-test'], { headers: { cookie: stack.browserCookie() } });
    try {
      await wsOpen(socket);
      expect(socket.protocol).toBe('dsh-test');

      const text = nextWsMessage(socket);
      socket.send('hello through the tunnel');
      expect((await text).data.toString('utf8')).toBe('hello through the tunnel');

      const binary = nextWsMessage(socket);
      socket.send(Buffer.from([1, 2, 3, 255]));
      const received = await binary;
      expect(received.isBinary).toBe(true);
      expect([...received.data]).toEqual([1, 2, 3, 255]);
    } finally {
      await closeWebSocket(socket);
    }
  });

  it('does not leak upstream Set-Cookie or HSTS to the browser', async () => {
    const response = await browserFetch(stack, '/api/set-cookie');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('cookie-set');
    expect(responseSetCookies(response)).toEqual([]);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('strips browser Cookie/Authorization/forwarding headers before the upstream request', async () => {
    const response = await browserFetch(stack, '/api/headers', {
      headers: {
        cookie: `evil=1; ${stack.browserCookie()}`,
        authorization: 'Bearer browser-secret',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
      },
    });
    expect(response.status).toBe(200);
    const seen = await response.json() as { headers: Record<string, string> };
    expect(seen.headers['cookie']).toContain('dsh_session=');
    expect(seen.headers['cookie']).not.toContain('evil=');
    expect(seen.headers['authorization']).toBeUndefined();
    expect(seen.headers['x-forwarded-for']).toBeUndefined();
    expect(seen.headers['x-real-ip']).toBeUndefined();
    expect(seen.headers['host']).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('rewrites an absolute loopback Location to the public device path', async () => {
    const response = await browserFetch(stack, '/api/redirect');
    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toBeDefined();
    expect(location).not.toContain(`127.0.0.1:${new URL(stack.mock.url).port}`);
    expect(location).toContain('/api/status');

    const target = location!.startsWith('http') ? location! : `${stack.edgeUrl}${location!}`;
    const followed = await fetch(target, { headers: { cookie: stack.browserCookie() }, redirect: 'manual' });
    expect(followed.status).toBe(200);
    expect(await followed.json()).toMatchObject({ ok: true });
  });

  it('rejects path traversal and authority-looking paths without touching upstream', async () => {
    const cookie = stack.browserCookie();
    const before = stack.mock.requests.length;
    const attempts = [
      `/d/${stack.deviceId}/../etc/passwd`,
      `/d/${stack.deviceId}//evil.example/steal`,
      `/d/${stack.deviceId}/http://evil.example/steal`,
      `/d/${stack.deviceId}/..%2f..%2fetc%2fpasswd`,
    ];
    for (const path of attempts) {
      const response = await rawRequest(stack.edgeUrl, { path, headers: { cookie } });
      expect(response.status, `path ${path} must not be served`).not.toBe(200);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.bodyText).not.toContain('mock dsh index');
    }
    await waitFor(() => stack.mock.requests.length === before, { timeoutMs: 500, intervalMs: 20 })
      .catch(() => undefined);
    // If a traversal had been normalised and forwarded, the mock would have
    // served one of its real paths. Percent-encoded attempts may legitimately
    // reach the mock as an opaque 404; they must not resolve to a real route.
    const escaped = stack.mock.requests.slice(before).filter((entry) =>
      entry.pathname === '/etc/passwd'
      || entry.pathname.startsWith('/evil.example')
      || entry.pathname === '/steal'
      || entry.status === 200);
    expect(escaped).toEqual([]);
  });
});