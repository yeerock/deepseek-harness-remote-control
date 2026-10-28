import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Open } from '@dsh-rc/protocol';
import type { Stream } from '@dsh-rc/mux';
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

function wsUrl(base: string, pathname: string): string {
  return `${base.replace(/^http/, 'ws')}${pathname}`;
}

function unexpectedResponse(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('expected the upgrade to fail')), 5_000);
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      resolve(response.statusCode ?? 0);
    });
    ws.once('open', () => {
      clearTimeout(timer);
      reject(new Error('upgrade unexpectedly succeeded'));
    });
  });
}

describe('WebSocket proxy', () => {
  it('relays text frames end to end after the agent OPEN_ACKs', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    let captured: Open | undefined;

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream: Stream) => {
        captured = stream.open;
        stream.sendOpenAck({ ok: true, protocol: 'dsh.v1' });
        stream.onFrame((opcode, data) => {
          stream.sendFrame(opcode, Buffer.from(data));
        });
      },
    });

    const ws = new WebSocket(wsUrl(edge.base, `/d/${device.deviceId}/api/remote.mux`), 'dsh.v1', {
      headers: { cookie: owner.jar.header() },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('unexpected-response', (_request, response) => reject(new Error(`upgrade failed with ${String(response.statusCode)}`)));
      });
      expect(ws.protocol).toBe('dsh.v1');
      expect(captured?.kind).toBe('ws');
      expect(captured?.priority).toBe('high');
      expect(captured?.path).toBe('/api/remote.mux');
      const names = (captured?.headers ?? []).map(([name]) => name);
      expect(names).not.toContain('cookie');
      expect(names).not.toContain('origin');

      ws.send('hello through the tunnel');
      const echoed = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no echo frame')), 5_000);
        ws.once('message', (data) => {
          clearTimeout(timer);
          resolve(data.toString());
        });
      });
      expect(echoed).toBe('hello through the tunnel');
    } finally {
      try {
        ws.close();
      } catch {
        ws.terminate();
      }
      await agent.close();
    }
  });

  it('turns an agent OPEN_ACK rejection into an HTTP error on the upgrade', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        stream.sendOpenAck({ ok: false, status: 403, message: 'upstream rejected the handshake' });
      },
    });
    try {
      const ws = new WebSocket(wsUrl(edge.base, `/d/${device.deviceId}/api/remote.mux`), {
        headers: { cookie: owner.jar.header() },
      });
      await expect(unexpectedResponse(ws)).resolves.toBe(403);
    } finally {
      await agent.close();
    }
  });

  it('times out with 504 when the agent never OPEN_ACKs', async () => {
    const edge = await boot({ wsOpenTimeoutMs: 100 });
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: () => {
        /* deliberately never acknowledge */
      },
    });
    try {
      const ws = new WebSocket(wsUrl(edge.base, `/d/${device.deviceId}/api/remote.mux`), {
        headers: { cookie: owner.jar.header() },
      });
      await expect(unexpectedResponse(ws)).resolves.toBe(504);
    } finally {
      await agent.close();
    }
  });

  it('returns 503 before upgrading when the device is offline', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const ws = new WebSocket(wsUrl(edge.base, `/d/${device.deviceId}/api/remote.mux`), {
      headers: { cookie: owner.jar.header() },
    });
    await expect(unexpectedResponse(ws)).resolves.toBe(503);
  });

  it('returns 401 before upgrading without a session cookie', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const ws = new WebSocket(wsUrl(edge.base, `/d/${device.deviceId}/api/remote.mux`));
    await expect(unexpectedResponse(ws)).resolves.toBe(401);
  });
});