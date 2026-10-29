import { afterEach, describe, expect, it } from 'vitest';
import { startEdge, type TestEdge } from './helpers.js';

const edges: TestEdge[] = [];

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

async function register(base: string, name: string): Promise<{ deviceId: string; deviceSecret: string }> {
  const response = await fetch(`${base}/v1/devices/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, platform: 'test', agentVersion: '0.2.2' }),
  });
  return (await response.json()) as { deviceId: string; deviceSecret: string };
}

function rename(base: string, targetId: string, secret: string | undefined, name: unknown): Promise<Response> {
  return fetch(`${base}/v1/devices/${targetId}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }) },
    body: JSON.stringify({ name }),
  });
}

describe('device rename', () => {
  it('lets an approved device rename itself and a peer', async () => {
    const edge = await startEdge({ autoApproveDevices: true });
    edges.push(edge);
    const a = await register(edge.base, 'office');
    const b = await register(edge.base, 'home');

    const own = await rename(edge.base, a.deviceId, a.deviceSecret, '  Office Mac  ');
    expect(own.status).toBe(200);
    expect(((await own.json()) as { name: string }).name).toBe('Office Mac');

    const peer = await rename(edge.base, b.deviceId, a.deviceSecret, 'Home PC');
    expect(peer.status).toBe(200);

    const peers = await fetch(`${edge.base}/v1/devices/me/peers`, { headers: { authorization: `Bearer ${a.deviceSecret}` } });
    const list = (await peers.json()) as { peers: Array<{ id: string; name: string }> };
    expect(list.peers.find((p) => p.id === b.deviceId)?.name).toBe('Home PC');
  });

  it('rejects missing auth, bad names and unknown targets', async () => {
    const edge = await startEdge({ autoApproveDevices: true });
    edges.push(edge);
    const a = await register(edge.base, 'office');
    expect((await rename(edge.base, a.deviceId, undefined, 'x')).status).toBe(401);
    expect((await rename(edge.base, a.deviceId, 'wrong-secret', 'x')).status).toBe(401);
    expect((await rename(edge.base, a.deviceId, a.deviceSecret, '')).status).toBe(400);
    expect((await rename(edge.base, a.deviceId, a.deviceSecret, 'a'.repeat(65))).status).toBe(400);
    expect((await rename(edge.base, a.deviceId, a.deviceSecret, 'bad\u0007name')).status).toBe(400);
    expect((await rename(edge.base, 'dev_nonexistentnonexistent', a.deviceSecret, 'x')).status).toBe(404);
  });

  it('does not let a pending device rename anything', async () => {
    const edge = await startEdge();
    edges.push(edge);
    const pending = await register(edge.base, 'pending');
    expect((await rename(edge.base, pending.deviceId, pending.deviceSecret, 'x')).status).toBe(403);
  });
});

import { isHostPluginPath } from '../src/server.js';

describe('host plugin path guard', () => {
  it('matches the plugin channel however it is encoded or cased', () => {
    for (const path of ['/dsh-rc', '/dsh-rc/status', '/DSH-RC/status', '/ds%68-rc/status', '//dsh-rc/x', '/%64sh-rc/host.set', '/dsh-rc%2Fstatus']) {
      expect(isHostPluginPath(path)).toBe(true);
    }
    for (const path of ['/', '/api/remote.mux', '/assets/index.js', '/dsh-rcx']) {
      expect(isHostPluginPath(path)).toBe(false);
    }
    expect(isHostPluginPath('/%E0%A4%A')).toBe(true);
  });
});
