/**
 * Fault injection: client abort propagation, offline presence/grace and
 * reconnect, and interactive latency while several bulk downloads are in
 * flight.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  browserFetch,
  startStack,
  waitFor,
  type LinkStack,
} from '../harness/link.js';

const MB = 1024 * 1024;

describe('faults and load', () => {
  let stack: LinkStack;

  beforeAll(async () => {
    stack = await startStack();
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('propagates a browser abort to the upstream DSH request', async () => {
    const controller = new AbortController();
    const response = await browserFetch(stack, '/api/abort-watch', { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(first.done).toBe(false);

    controller.abort();
    await reader!.cancel().catch(() => undefined);

    await waitFor(
      () => stack.mock.abortedRequests.some((entry) => entry.pathname === '/api/abort-watch'),
      { timeoutMs: 5000, intervalMs: 25, label: 'mock DSH observes upstream abort' },
    );
    const record = stack.mock.requestsTo('/api/abort-watch').at(-1);
    expect(record?.aborted).toBe(true);
    expect(record?.completed).toBe(false);
  });

  it('returns 503 + Retry-After while offline, then recovers within the presence grace', async () => {
    await stack.agent.stop();

    const offline = await waitFor(async () => {
      const response = await browserFetch(stack, '/api/status');
      return response.status === 503 ? response : undefined;
    }, { timeoutMs: 5000, intervalMs: 25, label: 'edge presence -> 503' });
    expect(offline.headers.get('retry-after')).toBe('5');
    const offlineBody = await offline.text();
    expect(offlineBody).toMatch(/reconnect|offline/i);

    // Restart with the same state directory: the persisted identity must be
    // reused (no re-pairing) and the tunnel must come back inside the 30 s
    // presence grace, so the browser recovers instead of staying offline.
    await stack.restartAgent();
    expect(stack.agent.status().state).toBe('online');

    const recovered = await waitFor(async () => {
      const response = await browserFetch(stack, '/api/status');
      return response.status === 200 ? response : undefined;
    }, { timeoutMs: 12_000, intervalMs: 25, label: 'edge recovers after agent reconnect' });
    expect(await recovered.json()).toMatchObject({ ok: true, upstream: 'mock-dsh' });
  });

  it('keeps small /api requests responsive while bulk downloads are in flight', async () => {
    const bulkStreams = 4;
    const bulkBytes = 32 * MB;
    let received = 0;
    let started = 0;
    let done = 0;

    const drains = Array.from({ length: bulkStreams }, () => (async () => {
      const response = await browserFetch(
        stack,
        `/assets/bulk.js?bytes=${String(bulkBytes)}&delayMs=2`,
      );
      expect(response.status).toBe(200);
      started += 1;
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      while (true) {
        const { done: finished, value } = await reader!.read();
        if (finished) break;
        received += value.byteLength;
      }
      done += 1;
    })());

    // Wait until every bulk stream has its response head.
    await waitFor(() => started === bulkStreams, { timeoutMs: 5000, intervalMs: 5, label: 'bulk downloads started' });

    const latencies: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const startedAt = performance.now();
      const response = await browserFetch(stack, '/api/status');
      const body = await response.arrayBuffer();
      latencies.push(performance.now() - startedAt);
      expect(response.status).toBe(200);
      expect(body.byteLength).toBeGreaterThan(0);
    }
    const maxLatency = Math.max(...latencies);
    console.log(`[priority] bulk in flight: done=${String(done)}/${String(bulkStreams)} small-request latencies(ms)=${latencies.map((value) => value.toFixed(1)).join(',')}`);
    // Interactive traffic must not wait for the bulk queues to drain. The mux
    // fairness ratio itself is unit-tested in packages/mux/tests.
    expect(maxLatency).toBeLessThan(750);

    await Promise.all(drains);
    expect(received).toBe(bulkStreams * bulkBytes);
  }, 20_000);
});