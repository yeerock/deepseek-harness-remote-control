import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS } from '../src/config.js';
import {
  Jar,
  extractCsrf,
  http,
  registerDevice,
  setupOwner,
  startEdge,
  type TestEdge,
} from './helpers.js';

const edges: TestEdge[] = [];

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

describe('rate limiting', () => {
  it('limits device registration per client address', async () => {
    const edge = await startEdge({
      rateLimits: { ...DEFAULT_RATE_LIMITS, register: { limit: 1, windowMs: 60_000 } },
    });
    edges.push(edge);
    await registerDevice(edge.base, 'first');
    const second = await http(edge.base, '/v1/devices/register', {
      method: 'POST',
      json: { name: 'second', platform: 'test', agentVersion: '0.1.0' },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect(await second.json()).toMatchObject({ error: 'RATE_LIMITED' });
  });

  it('limits setup attempts before the one-time code is checked', async () => {
    const edge = await startEdge({
      rateLimits: { ...DEFAULT_RATE_LIMITS, setup: { limit: 1, windowMs: 60_000 } },
    });
    edges.push(edge);
    const jar = new Jar();
    const page = await http(edge.base, '/setup', { jar });
    const csrf = extractCsrf(await page.text());
    const attempt = async (): Promise<Response> =>
      http(edge.base, '/setup', {
        method: 'POST',
        jar,
        form: { csrf, code: 'wrong-code' },
        headers: { origin: edge.base },
      });
    expect((await attempt()).status).toBe(403);
    expect((await attempt()).status).toBe(429);
  });

  it('limits login attempts', async () => {
    const edge = await startEdge({
      rateLimits: { ...DEFAULT_RATE_LIMITS, login: { limit: 1, windowMs: 60_000 } },
    });
    edges.push(edge);
    await setupOwner(edge.base);
    const jar = new Jar();
    const page = await http(edge.base, '/login', { jar });
    const csrf = extractCsrf(await page.text());
    const attempt = async (): Promise<Response> =>
      http(edge.base, '/login', {
        method: 'POST',
        jar,
        form: { csrf, password: 'wrong-password' },
        headers: { origin: edge.base },
      });
    expect((await attempt()).status).toBe(403);
    expect((await attempt()).status).toBe(429);
  });

  it('limits pair attempts so the 32-bit code cannot be brute-forced', async () => {
    const edge = await startEdge({
      rateLimits: { ...DEFAULT_RATE_LIMITS, pair: { limit: 2, windowMs: 60_000 } },
    });
    edges.push(edge);
    await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    const jar = new Jar();
    const page = await http(edge.base, `/pair?code=${device.pairCode}`, { jar });
    const csrf = extractCsrf(await page.text());

    const attempt = async (): Promise<Response> =>
      http(edge.base, '/pair', {
        method: 'POST',
        jar,
        form: { csrf, code: device.pairCode, password: 'wrong-password' },
        headers: { origin: edge.base },
      });

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
});