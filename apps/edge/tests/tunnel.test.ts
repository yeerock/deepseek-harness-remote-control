import { afterEach, describe, expect, it } from 'vitest';
import type { HelloAck } from '@dsh-rc/protocol';
import {
  connectTunnel,
  http,
  openTunnelSocket,
  pairDevice,
  provisionDevice,
  readHelloAck,
  registerDevice,
  sendHello,
  setupOwner,
  startEdge,
  waitForClose,
  type TestEdge,
} from './helpers.js';

const edges: TestEdge[] = [];

async function boot(): Promise<TestEdge> {
  const edge = await startEdge();
  edges.push(edge);
  return edge;
}

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

async function approveAsOwner(edge: TestEdge, deviceId: string): Promise<void> {
  const owner = await setupOwner(edge.base);
  await http(edge.base, `/v1/devices/${deviceId}/approve`, {
    method: 'POST',
    jar: owner.jar,
    headers: { origin: edge.base, 'x-csrf-token': owner.jar.get('dshrc_csrf') ?? '', accept: 'application/json' },
  });
}

describe('tunnel handshake', () => {
  it('rejects an unknown bearer secret at the HTTP upgrade', async () => {
    const edge = await boot();
    await expect(openTunnelSocket(edge.base, 'not-a-real-secret')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refuses a pending device with DEVICE_PENDING and close code 4002', async () => {
    const edge = await boot();
    const device = await registerDevice(edge.base);
    const ws = await openTunnelSocket(edge.base, device.deviceSecret);
    const closed = waitForClose(ws);
    sendHello(ws, device.deviceId, device.deviceSecret);
    const ack = await readHelloAck(ws);
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.code).toBe('DEVICE_PENDING');
    const close = await closed;
    expect(close.code).toBe(4002);
  });

  it('refuses a revoked device with DEVICE_REVOKED and close code 4003', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const revoke = await http(edge.base, `/v1/devices/${device.deviceId}/revoke`, {
      method: 'POST',
      jar: owner.jar,
      headers: { origin: edge.base, 'x-csrf-token': owner.jar.get('dshrc_csrf') ?? '', accept: 'application/json' },
    });
    expect(revoke.status).toBe(200);

    const ws = await openTunnelSocket(edge.base, device.deviceSecret);
    const closed = waitForClose(ws);
    sendHello(ws, device.deviceId, device.deviceSecret);
    const ack = await readHelloAck(ws);
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.code).toBe('DEVICE_REVOKED');
    expect((await closed).code).toBe(4003);
  });

  it('rejects a HELLO whose device id or token does not match', async () => {
    const edge = await boot();
    const device = await registerDevice(edge.base);
    await approveAsOwner(edge, device.deviceId);

    const mismatchedId = await openTunnelSocket(edge.base, device.deviceSecret);
    const closedId = waitForClose(mismatchedId);
    sendHello(mismatchedId, 'dev_aaaaaaaaaaaaaaaaaaaa', device.deviceSecret);
    const ackId = await readHelloAck(mismatchedId);
    expect(ackId.ok).toBe(false);
    if (!ackId.ok) expect(ackId.code).toBe('AUTH_FAILED');
    expect((await closedId).code).toBe(4002);

    const mismatchedToken = await openTunnelSocket(edge.base, device.deviceSecret);
    const closedToken = waitForClose(mismatchedToken);
    const other = await registerDevice(edge.base, 'other');
    sendHello(mismatchedToken, device.deviceId, other.deviceSecret);
    const ackToken = await readHelloAck(mismatchedToken);
    expect(ackToken.ok).toBe(false);
    if (!ackToken.ok) expect(ackToken.code).toBe('AUTH_FAILED');
    expect((await closedToken).code).toBe(4002);
  });

  it('accepts an approved device and returns the documented HELLO_ACK fields', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret);
    try {
      const ack: HelloAck = agent.ack;
      expect(ack.ok).toBe(true);
      if (ack.ok) {
        expect(ack.protocol).toBe(1);
        expect(ack.edgeId).toMatch(/^edge_/);
        expect(ack.heartbeatMs).toBe(15_000);
        expect(ack.idleTimeoutMs).toBe(45_000);
        expect(ack.initialStreamWindow).toBe(256 * 1024);
        expect(ack.initialConnectionWindow).toBe(8 * 1024 * 1024);
        expect(ack.maxFrameBytes).toBe(64 * 1024);
        expect(ack.serverTime).toBeGreaterThan(0);
      }
    } finally {
      await agent.close();
    }
  });

  it('replaces an older tunnel with close code 4004 and serves the newest one', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const first = await connectTunnel(edge.base, device.deviceId, device.deviceSecret);
    const firstClosed = waitForClose(first.ws);
    const second = await connectTunnel(edge.base, device.deviceId, device.deviceSecret);
    try {
      const close = await firstClosed;
      expect(close.code).toBe(4004);
      const status = await http(edge.base, '/v1/devices/me', {
        headers: { authorization: `Bearer ${device.deviceSecret}` },
      });
      expect(await status.json()).toMatchObject({ online: true, status: 'approved' });
    } finally {
      await second.close();
    }
  });

  it('does not let a browser pair code ride on an unapproved device tunnel', async () => {
    const edge = await boot();
    await setupOwner(edge.base);
    const device = await registerDevice(edge.base);
    const paired = await pairDevice(edge.base, device.pairCode, { password: 'test-password-1' });
    expect(paired.response.status).toBe(303);
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret);
    await agent.close();
  });
});