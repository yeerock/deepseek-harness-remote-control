import { afterEach, describe, expect, it } from 'vitest';
import { MockDsh } from './helpers/mock-dsh.js';
import { MockEdge, type EdgeTunnel } from './helpers/mock-edge.js';
import { nextFrame, startTestAgent, type TestAgent } from './helpers/agent.js';
import type { Open } from '@dsh-rc/protocol';

interface Harness {
  dsh: MockDsh;
  edge: MockEdge;
  agent: TestAgent;
  tunnel: EdgeTunnel;
}

let harness: Harness | undefined;

async function setup(): Promise<Harness> {
  const dsh = new MockDsh({ token: 'launch-secret' });
  await dsh.start();
  const edge = new MockEdge({ autoApprove: true });
  await edge.start();
  const agent = await startTestAgent({ edgeUrl: edge.url, dshUrl: dsh.authenticatedUrl });
  await agent.agent.waitForOnline(8_000);
  const tunnel = await edge.waitForTunnel();
  harness = { dsh, edge, agent, tunnel };
  return harness;
}

afterEach(async () => {
  const current = harness;
  harness = undefined;
  if (current === undefined) return;
  await current.agent.cleanup();
  await current.edge.stop();
  await current.dsh.stop();
});

function wsOpen(open: Partial<Open> & Pick<Open, 'path'>): Open {
  return {
    kind: 'ws',
    method: 'GET',
    headers: [['sec-websocket-protocol', 'dsh-remote']],
    priority: 'high',
    ...open,
  };
}

describe('WebSocket stream proxy through the tunnel', () => {
  it('opens the upstream socket and relays text frames both ways with filtered headers', async () => {
    const { dsh, edge } = await setup();
    const stream = edge.openWs(
      wsOpen({
        path: '/ws',
        headers: [
          ['sec-websocket-protocol', 'dsh-remote'],
          ['cookie', 'browser=should-not-cross'],
          ['authorization', 'Bearer browser-token'],
          ['x-custom-test', 'keep-me'],
        ],
      }),
    );

    const ack = await stream.openAck();
    expect(ack.ok).toBe(true);
    expect(ack.protocol).toBe('dsh-remote');

    const responseFrame = nextFrame(stream);
    stream.sendFrame(1, new TextEncoder().encode('hello'));
    const frame = await responseFrame;
    expect(frame.opcode).toBe(1);
    expect(frame.data.toString('utf8')).toBe('echo:hello');

    const upstream = dsh.wsRequests[0];
    expect(upstream).toBeDefined();
    expect(upstream?.protocol).toBe('dsh-remote');
    expect(upstream?.headers.cookie).toContain('dsh_session=');
    expect(upstream?.headers.cookie).not.toContain('browser=');
    expect(upstream?.headers.authorization).toBeUndefined();
    expect(upstream?.headers['x-custom-test']).toBe('keep-me');
    expect(upstream?.headers.host).toBe(`127.0.0.1:${String(dsh.port)}`);

    stream.sendClose(1000, 'bye');
    await stream.waitForEnd();
  });

  it('relays binary frames', async () => {
    const { edge } = await setup();
    const stream = edge.openWs(wsOpen({ path: '/ws' }));
    const ack = await stream.openAck();
    expect(ack.ok).toBe(true);

    const responseFrame = nextFrame(stream);
    stream.sendFrame(2, new Uint8Array([1, 2, 3]));
    const frame = await responseFrame;
    expect(frame.opcode).toBe(2);
    expect([...frame.data]).toEqual([...Buffer.from('echo:') , 1, 2, 3]);
  });

  it('reports OPEN_ACK{ok:false} when the upstream upgrade fails', async () => {
    const { edge } = await setup();
    const stream = edge.openWs(wsOpen({ path: '/nope' }));
    const ack = await stream.openAck();
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe(502);
    await stream.waitForEnd();
  });

  it('rejects an unsafe ws path before touching DSH', async () => {
    const { dsh, edge } = await setup();
    const stream = edge.openWs(wsOpen({ path: '/%2e%2e/ws' }));
    const ack = await stream.openAck();
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe(400);
    await stream.waitForEnd();
    expect(dsh.wsRequests).toHaveLength(0);
  });

  it('reports a failed cookie refresh instead of hanging the upgrade', async () => {
    const { dsh, edge } = await setup();
    const warmup = edge.openHttp({
      kind: 'http',
      method: 'GET',
      path: '/',
      headers: [['accept', 'text/html']],
      priority: 'high',
    });
    expect((await warmup.head()).status).toBe(200);
    await warmup.waitForEnd();
    expect(dsh.exchangeCount).toBe(1);

    dsh.invalidateCookies();
    dsh.token = 'rotated-away';
    const stream = edge.openWs(wsOpen({ path: '/ws' }));
    const ack = await stream.openAck();
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe(401);
    await stream.waitForEnd();
  });

  it('refreshes the cookie once on a 401 upgrade and then connects', async () => {
    const { dsh, edge } = await setup();
    // Force the one-time token → cookie exchange with an HTTP request first.
    const warmup = edge.openHttp({
      kind: 'http',
      method: 'GET',
      path: '/',
      headers: [['accept', 'text/html']],
      priority: 'high',
    });
    expect((await warmup.head()).status).toBe(200);
    await warmup.waitForEnd();
    expect(dsh.exchangeCount).toBe(1);

    dsh.invalidateCookies();

    const stream = edge.openWs(wsOpen({ path: '/ws' }));
    const ack = await stream.openAck();
    expect(ack.ok).toBe(true);
    expect(dsh.exchangeCount).toBe(2);

    const responseFrame = nextFrame(stream);
    stream.sendFrame(1, new TextEncoder().encode('after-refresh'));
    const frame = await responseFrame;
    expect(frame.data.toString('utf8')).toBe('echo:after-refresh');
    stream.sendClose(1000, 'done');
    await stream.waitForEnd();
  });
});