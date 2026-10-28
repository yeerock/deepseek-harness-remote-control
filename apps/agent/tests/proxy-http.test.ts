import { afterEach, describe, expect, it } from 'vitest';
import type { Stream } from '@dsh-rc/mux';
import { MockDsh } from './helpers/mock-dsh.js';
import { MockEdge, waitUntil, type EdgeTunnel } from './helpers/mock-edge.js';
import { readBody, startTestAgent, type TestAgent } from './helpers/agent.js';
import type { RuntimeInternals } from '../src/runtime.js';
import type { Open } from '@dsh-rc/protocol';
import { buildUpstreamHeaders } from '../src/proxy-http.js';
import type { DshTarget } from '../src/dsh-session.js';

interface Harness {
  dsh: MockDsh;
  edge: MockEdge;
  agent: TestAgent;
  tunnel: EdgeTunnel;
}

let harness: Harness | undefined;

async function setup(options: {
  autoApprove?: boolean;
  dshUrl?: string;
  dshUrlFile?: string;
  internals?: RuntimeInternals;
  mockDsh?: Partial<ConstructorParameters<typeof MockDsh>[0]>;
} = {}): Promise<Harness> {
  const dsh = new MockDsh({ token: 'launch-secret', ...options.mockDsh });
  await dsh.start();
  const edge = new MockEdge({ autoApprove: options.autoApprove ?? true });
  await edge.start();
  try {
    const agent = await startTestAgent({
      edgeUrl: edge.url,
      dshUrl: options.dshUrl ?? dsh.authenticatedUrl,
      ...(options.dshUrlFile === undefined ? {} : { dshUrlFile: options.dshUrlFile }),
      ...(options.internals === undefined ? {} : { internals: options.internals }),
    });
    await agent.agent.waitForOnline(8_000);
    const tunnel = await edge.waitForTunnel();
    harness = { dsh, edge, agent, tunnel };
    return harness;
  } catch (error) {
    await edge.stop();
    await dsh.stop();
    throw error;
  }
}

afterEach(async () => {
  const current = harness;
  harness = undefined;
  if (current === undefined) return;
  await current.agent.cleanup();
  await current.edge.stop();
  await current.dsh.stop();
});

function httpOpen(open: Partial<Open> & Pick<Open, 'path'>): Open {
  return {
    kind: 'http',
    method: 'GET',
    headers: [['accept', '*/*']],
    priority: 'high',
    ...open,
  };
}

describe('HTTP stream proxy through the tunnel', () => {
  it('proxies GET / end to end with the agent cookie and rewritten Host', async () => {
    const { dsh, edge } = await setup();
    const stream = edge.openHttp(httpOpen({ path: '/', headers: [['accept', 'text/html'], ['user-agent', 'test-browser']] }));
    const head = await stream.head();
    const body = await readBody(stream);

    expect(head.status).toBe(200);
    expect(head.headers.some(([name]) => name === 'content-type')).toBe(true);
    expect(body.toString('utf8')).toContain('dsh-home');

    const upstream = dsh.requests.at(-1);
    expect(upstream).toBeDefined();
    expect(upstream?.path).toBe('/');
    expect(upstream?.headers.cookie).toContain('dsh_session=');
    expect(upstream?.headers.host).toBe(`127.0.0.1:${String(dsh.port)}`);
    expect(upstream?.headers['user-agent']).toBe('test-browser');
  });

  it('streams a POST request body upstream and returns the response body', async () => {
    const { edge } = await setup();
    const payload = 'hello world';
    const stream = edge.openHttp(
      httpOpen({
        method: 'POST',
        path: '/echo',
        headers: [
          ['content-type', 'text/plain'],
          ['content-length', String(Buffer.byteLength(payload))],
        ],
        priority: 'normal',
      }),
    );
    await stream.write(new TextEncoder().encode(payload));
    await stream.end();

    const head = await stream.head();
    const body = await readBody(stream);
    expect(head.status).toBe(200);
    expect(JSON.parse(body.toString('utf8')) as { body: string }).toEqual({
      method: 'POST',
      body: payload,
      length: Buffer.byteLength(payload),
    });
  });

  it('rebuilds headers: no browser cookie/authorization/forwarding, keeps allow-listed ones', async () => {
    const { dsh, edge } = await setup();
    const stream = edge.openHttp(
      httpOpen({
        path: '/echo-headers',
        headers: [
          ['accept', 'application/json'],
          ['cookie', 'browser=session-should-not-cross'],
          ['authorization', 'Bearer browser-token'],
          ['x-forwarded-for', '203.0.113.9'],
          ['origin', 'https://edge.example'],
          ['x-custom-test', 'keep-me'],
        ],
      }),
    );
    expect((await stream.head()).status).toBe(200);
    const body = await readBody(stream);
    const headers = (JSON.parse(body.toString('utf8')) as { headers: Record<string, string> }).headers;

    expect(headers['cookie']).toContain('dsh_session=');
    expect(headers['cookie']).not.toContain('browser=');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['origin']).toBeUndefined();
    expect(headers['x-custom-test']).toBe('keep-me');
    expect(headers['host']).toBe(`127.0.0.1:${String(dsh.port)}`);
  });

  it('drops upstream Set-Cookie and HSTS from the response', async () => {
    const { edge } = await setup();
    const stream = edge.openHttp(httpOpen({ path: '/set-cookie' }));
    const head = await stream.head();
    expect(head.status).toBe(200);
    expect(head.headers.map(([name]) => name)).not.toContain('set-cookie');
    expect(head.headers.map(([name]) => name)).not.toContain('strict-transport-security');
    expect(head.headers.some(([name, value]) => name === 'x-upstream' && value === 'yes')).toBe(true);
    expect((await readBody(stream)).toString('utf8')).toBe('ok');
  });

  it('marks HEAD responses bodyless and sends no DATA', async () => {
    const { edge } = await setup();
    const stream = edge.openHttp(httpOpen({ method: 'HEAD', path: '/' }));
    const head = await stream.head();
    expect(head.status).toBe(200);
    expect(head.bodyless).toBe(true);
    const body = await readBody(stream);
    expect(body.byteLength).toBe(0);
  });

  it('streams a large response with intact bytes', async () => {
    const { edge } = await setup();
    const total = 300_000;
    const stream = edge.openHttp(httpOpen({ path: `/stream?bytes=${String(total)}`, priority: 'low' }));
    expect((await stream.head()).status).toBe(200);
    const body = await readBody(stream);
    expect(body.byteLength).toBe(total);
    expect(body.subarray(0, 4).toString('utf8')).toBe('aaaa');
    expect(body.subarray(total - 4).toString('utf8')).toBe('aaaa');
  });

  it('rejects an encoded traversal path before touching DSH', async () => {
    const { dsh, edge } = await setup();
    const stream = edge.openHttp(httpOpen({ path: '/%2e%2e/secret' }));
    const ack = await stream.openAck();
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe(400);
    await stream.waitForEnd();
    expect(dsh.requests).toHaveLength(0);
    expect(dsh.exchangeCount).toBe(0);
  });

  it('destroys the upstream request when the edge resets the stream', async () => {
    const { dsh, edge } = await setup();
    const stream = edge.openHttp(httpOpen({ path: '/slow' }));
    const slow = await dsh.waitForSlowRequest();
    stream.reset('CLIENT_ABORTED', 'browser went away', true);
    await slow.closed;
    expect(stream.isClosed).toBe(true);
  });

  it('enforces the request body byte cap', async () => {
    const { edge } = await setup({ internals: { maxBodyBytes: 16 } });
    const stream = edge.openHttp(
      httpOpen({
        method: 'POST',
        path: '/echo',
        headers: [['content-type', 'text/plain']],
      }),
    );
    await stream.write(Buffer.alloc(64, 0x61));
    await stream.end();
    const ack = await stream.openAck();
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe(413);
    await stream.waitForEnd();
    expect(stream.isClosed).toBe(true);
  });
});

describe('upstream header safety', () => {
  const target: DshTarget = {
    origin: 'http://127.0.0.1:1234',
    protocol: 'http:',
    host: '127.0.0.1',
    port: 1234,
    hostHeader: '127.0.0.1:1234',
  };

  it('drops edge-supplied content-length/expect so Node frames the re-streamed body', () => {
    const headers = buildUpstreamHeaders(
      httpOpen({
        method: 'POST',
        path: '/echo',
        headers: [
          ['content-length', '999999'],
          ['expect', '100-continue'],
          ['x-custom', 'keep'],
        ],
      }),
      target,
      'dsh_session=s1',
    );
    expect(headers['content-length']).toBeUndefined();
    expect(headers['expect']).toBeUndefined();
    expect(headers['x-custom']).toBe('keep');
    expect(headers['host']).toBe('127.0.0.1:1234');
    expect(headers['cookie']).toBe('dsh_session=s1');
  });

  it('always rewrites Host to the loopback target', () => {
    const headers = buildUpstreamHeaders(httpOpen({ path: '/', headers: [['host', 'evil.example']] }), target, undefined);
    expect(headers['host']).toBe('127.0.0.1:1234');
  });
});

describe('DSH authentication failure handling', () => {
  it('surfaces an actionable error when no token is available and DSH answers 401', async () => {
    const dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    const edge = new MockEdge({ autoApprove: true });
    await edge.start();
    const testAgent = await startTestAgent({ edgeUrl: edge.url, dshUrl: dsh.url });
    try {
      await testAgent.agent.waitForOnline(8_000);
      const stream = edge.openHttp(httpOpen({ path: '/' }));
      const head = await stream.head();
      expect(head.status).toBe(401);
      await readBody(stream);
      await waitUntil(() => testAgent.agent.status().state === 'error', 5_000, 'error status');
      expect(testAgent.agent.status().lastError).toContain('DSH RC plugin');
      expect(testAgent.agent.status().lastError).toContain('authenticated URL');
    } finally {
      await testAgent.cleanup();
      await edge.stop();
      await dsh.stop();
    }
  });

  it('does not start a second upstream request when RESET lands during refresh', async () => {
    const { dsh, edge } = await setup();
    const warmup = edge.openHttp(httpOpen({ path: '/' }));
    expect((await warmup.head()).status).toBe(200);
    await readBody(warmup);
    expect(dsh.exchangeCount).toBe(1);

    dsh.invalidateCookies();
    dsh.exchangeDelayMs = 500;
    const pathRequests = (): number => dsh.requests.filter((request) => request.path === '/').length;

    const stream = edge.openHttp(httpOpen({ path: '/' }));
    // Wait until the refresh exchange is actually in flight (the first GET
    // already received its 401), then abort.
    await dsh.waitForExchangeStart(2);
    const afterFirstAttempt = pathRequests();
    expect(afterFirstAttempt).toBeGreaterThanOrEqual(2);
    stream.reset('CLIENT_ABORTED', 'browser went away during refresh', true);
    await stream.waitForEnd();
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(pathRequests()).toBe(afterFirstAttempt);
    expect(stream.isClosed).toBe(true);
  });

  it('refreshes the cookie once on upstream 401 and retries the GET', async () => {
    const { dsh, edge } = await setup();
    const first = edge.openHttp(httpOpen({ path: '/' }));
    expect((await first.head()).status).toBe(200);
    await readBody(first);
    expect(dsh.exchangeCount).toBe(1);

    dsh.invalidateCookies();
    const stream = edge.openHttp(httpOpen({ path: '/' }));
    const head = await stream.head();
    const body = await readBody(stream);
    expect(head.status).toBe(200);
    expect(body.toString('utf8')).toContain('dsh-home');
    expect(dsh.exchangeCount).toBe(2);
  });
});