import { afterEach, describe, expect, it } from 'vitest';
import type { Stream } from '@dsh-link/mux';
import { connectTunnel, http, provisionDevice, setupOwner, startEdge, type TestEdge } from './helpers.js';

const edges: TestEdge[] = [];

async function boot(overrides: Parameters<typeof startEdge>[0] = {}): Promise<TestEdge> {
  const edge = await startEdge(overrides);
  edges.push(edge);
  return edge;
}

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

function respondOk(stream: Stream): void {
  void (async () => {
    for await (const _chunk of stream.body()) {
      /* drain the request */
    }
    stream.sendHead({ status: 200, headers: [['content-type', 'text/html; charset=utf-8']] });
    await stream.write(Buffer.from('<h1>DSH is up</h1>'));
    await stream.end();
  })();
}

async function waitForStatus(url: string, init: RequestInit, status: number, deadlineMs = 2_000): Promise<Response> {
  const deadline = Date.now() + deadlineMs;
  let last: Response | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(url, init);
    last = response;
    if (response.status === status) return response;
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (last === undefined) throw new Error('no response while polling');
  return last;
}

describe('presence grace', () => {
  it('is online while connected, reconnecting within the grace window, then offline', async () => {
    const edge = await boot({ presenceGraceMs: 250 });
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, { onStream: respondOk });

    const online = await http(edge.base, `/d/${device.deviceId}/`, { jar: owner.jar, headers: { accept: 'text/html' } });
    expect(online.status).toBe(200);
    expect(await online.text()).toContain('DSH is up');

    await agent.close();

    const reconnecting = await waitForStatus(`${edge.base}/d/${device.deviceId}/`, { headers: { cookie: owner.jar.header(), accept: 'text/html' } }, 503);
    expect(reconnecting.headers.get('retry-after')).toBe('5');
    expect(await reconnecting.text()).toContain('Reconnecting');

    const api = await http(edge.base, `/d/${device.deviceId}/api/state`, { jar: owner.jar, headers: { accept: 'application/json' } });
    expect(api.status).toBe(503);
    expect(api.headers.get('retry-after')).toBe('5');
    expect(await api.json()).toMatchObject({ error: 'DEVICE_OFFLINE', retryable: true, reconnecting: true, retryAfterSeconds: 5 });

    await new Promise((resolve) => setTimeout(resolve, 350));
    const offline = await http(edge.base, `/d/${device.deviceId}/`, { jar: owner.jar, headers: { accept: 'text/html' } });
    expect(offline.status).toBe(503);
    expect(await offline.text()).toContain('Device offline');
  });

  it('comes back to 200 when the agent reconnects inside the grace window', async () => {
    const edge = await boot({ presenceGraceMs: 5_000 });
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const first = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, { onStream: respondOk });
    await first.close();
    await waitForStatus(`${edge.base}/d/${device.deviceId}/`, { headers: { cookie: owner.jar.header(), accept: 'text/html' } }, 503);

    const second = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, { onStream: respondOk });
    try {
      const online = await waitForStatus(`${edge.base}/d/${device.deviceId}/`, { headers: { cookie: owner.jar.header(), accept: 'text/html' } }, 200);
      expect(await online.text()).toContain('DSH is up');
    } finally {
      await second.close();
    }
  });
});