import { afterEach, describe, expect, it } from 'vitest';
import type { Open } from '@dsh-rc/protocol';
import {
  connectTunnel,
  http,
  pairDevice,
  provisionDevice,
  registerDevice,
  setupOwner,
  startEdge,
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

describe('HTTP proxy', () => {
  it('filters browser credentials and response cookies, and rewrites loopback redirects', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    let captured: Open | undefined;

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        captured = stream.open;
        void (async () => {
          for await (const _chunk of stream.body()) {
            /* drain the request */
          }
          stream.sendHead({
            status: 200,
            headers: [
              ['content-type', 'text/plain; charset=utf-8'],
              ['set-cookie', 'session=leak'],
              ['set-cookie', 'other=leak2'],
              ['location', 'http://127.0.0.1:7777/login?next=%2Flogged-in'],
              ['x-edge-test', 'yes'],
            ],
          });
          await stream.write(Buffer.from('hello from dsh'));
          await stream.end();
        })();
      },
    });

    try {
      const response = await fetch(`${edge.base}/d/${device.deviceId}/some/path?q=1`, {
        headers: {
          cookie: `${owner.jar.header()}; evil=1`,
          origin: 'https://evil.example',
          authorization: 'Bearer browser-token',
          'sec-fetch-dest': 'document',
          'x-forwarded-for': '203.0.113.9',
          referer: 'https://evil.example/',
          accept: 'text/html',
          'x-dsh-rc-extra': '1',
        },
        redirect: 'manual',
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hello from dsh');
      expect(response.headers.getSetCookie()).toEqual([]);
      // Absolute loopback redirects are rewritten onto the public device mount.
      expect(response.headers.get('location')).toBe(`/d/${device.deviceId}/login?next=%2Flogged-in`);
      expect(response.headers.get('x-edge-test')).toBe('yes');

      expect(captured).toBeDefined();
      const open = captured as Open;
      expect(open.kind).toBe('http');
      expect(open.method).toBe('GET');
      expect(open.path).toBe('/some/path?q=1');
      expect(open.priority).toBe('high');
      const names = open.headers.map(([name]) => name.toLowerCase());
      for (const forbidden of ['cookie', 'authorization', 'origin', 'referer', 'host', 'sec-fetch-dest', 'x-forwarded-for', 'x-dsh-rc-extra']) {
        expect(names, `header ${forbidden} must not reach the agent`).not.toContain(forbidden);
      }
      expect(names).toContain('accept');
      expect(open.headers.find(([name]) => name === 'accept')?.[1]).toBe('text/html');
    } finally {
      await agent.close();
    }
  });

  it('streams request and response bodies in both directions', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    let captured: Open | undefined;

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        captured = stream.open;
        void (async () => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream.body()) chunks.push(chunk);
          const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
          const upper = body.toUpperCase();
          stream.sendHead({
            status: 201,
            headers: [
              ['content-type', 'text/plain'],
              ['content-length', String(Buffer.byteLength(upper))],
            ],
          });
          await stream.write(Buffer.from(upper));
          await stream.end();
        })();
      },
    });

    try {
      const response = await http(edge.base, `/d/${device.deviceId}/echo`, {
        method: 'POST',
        jar: owner.jar,
        headers: { 'content-type': 'text/plain' },
        body: 'ping body',
      });
      expect(response.status).toBe(201);
      expect(await response.text()).toBe('PING BODY');
      const open = captured as Open;
      expect(open.method).toBe('POST');
      expect(open.path).toBe('/echo');
    } finally {
      await agent.close();
    }
  });

  it('preserves a large streamed body byte-for-byte', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const chunk = Buffer.alloc(16 * 1024, 0x5a);
    const totalChunks = 16;

    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        void (async () => {
          for await (const _chunk of stream.body()) {
            /* drain */
          }
          stream.sendHead({
            status: 200,
            headers: [
              ['content-type', 'application/octet-stream'],
              ['content-length', String(chunk.byteLength * totalChunks)],
            ],
          });
          for (let index = 0; index < totalChunks; index += 1) await stream.write(chunk);
          await stream.end();
        })();
      },
    });

    try {
      const response = await http(edge.base, `/d/${device.deviceId}/blob`, { jar: owner.jar });
      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.byteLength).toBe(chunk.byteLength * totalChunks);
      expect(body[0]).toBe(0x5a);
      expect(body[body.byteLength - 1]).toBe(0x5a);
    } finally {
      await agent.close();
    }
  });

  it('leaves non-loopback Location headers untouched', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        void (async () => {
          for await (const _chunk of stream.body()) {
            /* drain */
          }
          stream.sendHead({ status: 302, headers: [['location', 'https://example.com/somewhere']] });
          await stream.end();
        })();
      },
    });
    try {
      const response = await http(edge.base, `/d/${device.deviceId}/redirect`, { jar: owner.jar });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://example.com/somewhere');
    } finally {
      await agent.close();
    }
  });
});

describe('device path rules', () => {
  it('rejects unauthenticated access, bad ids and path traversal', async () => {
    const edge = await boot();
    const device = await registerDevice(edge.base);

    const anonymous = await http(edge.base, `/d/${device.deviceId}/`);
    expect(anonymous.status).toBe(401);

    const unknown = await http(edge.base, '/d/not-a-device/');
    expect(unknown.status).toBe(404);

    const owner = await setupOwner(edge.base);
    const paired = await pairDevice(edge.base, device.pairCode, { ownerJar: owner.jar });
    expect(paired.response.status).toBe(303);

    // WHATWG URL normalisation turns %2e%2e into a dot segment, so this is
    // rejected as an unknown device path rather than a traversal.
    const traversal = await http(edge.base, `/d/${device.deviceId}/%2e%2e/secret`, { jar: owner.jar });
    expect([400, 404]).toContain(traversal.status);

    const encodedSlashTraversal = await http(edge.base, `/d/${device.deviceId}/..%2f..%2fetc%2fpasswd`, { jar: owner.jar });
    expect(encodedSlashTraversal.status).toBe(400);
  });

  it('redirects /d/:id to /d/:id/ and keeps the query string', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);
    const response = await http(edge.base, `/d/${device.deviceId}?tab=chat&x=1`, { jar: owner.jar });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/d/${device.deviceId}/?tab=chat&x=1`);
  });

  it('refuses a device-bound session on a different device', async () => {
    const edge = await boot();
    const owner = await setupOwner(edge.base);
    const first = await provisionDevice(edge.base, owner.jar);
    const secondDevice = await registerDevice(edge.base, 'second');
    const second = await pairDevice(edge.base, secondDevice.pairCode, { ownerJar: owner.jar });
    expect(second.response.status).toBe(303);

    const sessionForFirst = await pairDevice(edge.base, first.device.pairCode, { ownerJar: owner.jar });
    expect(sessionForFirst.response.status).toBe(403); // code already used
    // Create a genuine device-scoped session on the second device.
    const thirdDevice = await registerDevice(edge.base, 'third');
    const deviceJar = await pairDevice(edge.base, thirdDevice.pairCode, { password: 'test-password-1' });
    expect(deviceJar.response.status).toBe(303);

    const cross = await http(edge.base, `/d/${first.device.deviceId}/`, { jar: deviceJar.jar });
    expect(cross.status).toBe(403);
  });
});