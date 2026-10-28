import { request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_STREAMS } from '@dsh-link/protocol';
import { connectTunnel, http, provisionDevice, setupOwner, startEdge, type TestEdge } from './helpers.js';

const edges: TestEdge[] = [];

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('mux stream-limit saturation', () => {
  it('returns 503 + Retry-After 1 instead of 502 when the device tunnel is at its stream ceiling', async () => {
    const edge = await startEdge();
    edges.push(edge);
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);

    // The fake agent accepts streams but never answers them, holding every one
    // of them open on the edge.
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: () => {
        /* hold the stream open */
      },
    });
    const pending: ClientRequest[] = [];

    try {
      const cookie = owner.jar.header();
      for (let index = 0; index < MAX_CONCURRENT_STREAMS; index += 1) {
        const request = httpRequest(`${edge.base}/d/${device.deviceId}/hold-${String(index)}`, {
          method: 'GET',
          headers: { cookie, accept: 'text/html' },
        });
        request.on('error', () => undefined);
        request.end();
        pending.push(request);
      }
      await waitFor(
        () => (agent.streams.filter((stream) => stream.kind === 'http').length >= MAX_CONCURRENT_STREAMS ? true : undefined),
        10_000,
        'the edge to open all stream slots',
      );

      const api = await http(edge.base, `/d/${device.deviceId}/api/over-limit`, {
        jar: owner.jar,
        headers: { accept: 'application/json' },
      });
      expect(api.status).toBe(503);
      expect(api.headers.get('retry-after')).toBe('1');
      expect(await api.json()).toMatchObject({ error: 'STREAM_LIMIT', retryable: true, retryAfterSeconds: 1 });

      const page = await http(edge.base, `/d/${device.deviceId}/over-limit`, {
        jar: owner.jar,
        headers: { accept: 'text/html' },
      });
      expect(page.status).toBe(503);
      expect(page.headers.get('retry-after')).toBe('1');
      expect(await page.text()).toContain('stream limit');
    } finally {
      for (const request of pending) {
        try {
          request.destroy();
        } catch {
          /* already gone */
        }
      }
      await agent.close();
    }
  });
});