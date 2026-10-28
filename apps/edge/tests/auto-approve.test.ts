import { afterEach, describe, expect, it } from 'vitest';
import { startEdge, type TestEdge } from './helpers.js';

const edges: TestEdge[] = [];

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

async function register(base: string, name: string): Promise<{ status: string; deviceId: string; deviceSecret: string }> {
  const response = await fetch(`${base}/v1/devices/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, platform: 'test', agentVersion: '0.2.2' }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { status: string; deviceId: string; deviceSecret: string };
}

describe('device auto-approval', () => {
  it('keeps devices pending by default', async () => {
    const edge = await startEdge();
    edges.push(edge);
    const device = await register(edge.base, 'pending-harness');
    expect(device.status).toBe('pending');
  });

  it('approves a paired Harness immediately when enabled', async () => {
    const edge = await startEdge({ autoApproveDevices: true });
    edges.push(edge);
    const device = await register(edge.base, 'auto-harness');
    expect(device.status).toBe('approved');

    const me = await fetch(`${edge.base}/v1/devices/me`, {
      headers: { authorization: `Bearer ${device.deviceSecret}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { status: string }).status).toBe('approved');
  });

  it('parses the CLI flag and env var', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig({ argv: ['--insecure', '--auto-approve-devices'] }).autoApproveDevices).toBe(true);
    expect(loadConfig({ argv: ['--insecure'], env: { DSHRC_AUTO_APPROVE_DEVICES: 'true' } }).autoApproveDevices).toBe(true);
    expect(loadConfig({ argv: ['--insecure'], env: {} }).autoApproveDevices).toBe(false);
  });
});