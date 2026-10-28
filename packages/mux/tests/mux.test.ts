import { describe, expect, it } from 'vitest';
import { FrameType, decodeFrame, type Open } from '@dsh-link/protocol';
import { Mux, type MuxOptions, type Stream, type MuxTransport } from '../src/index.js';

interface Pair {
  edge: Mux;
  agent: Mux;
}

/**
 * Two muxes wired back-to-back. Delivery is asynchronous on purpose: a mux
 * that only works when the peer runs synchronously hides reentrancy bugs.
 */
function pair(agentOptions: Partial<MuxOptions> = {}, window = 256 * 1024): Pair {
  let edge: Mux;
  let agent: Mux;

  const edgeTransport: MuxTransport = {
    send: (data) => { setTimeout(() => agent.handleMessage(data), 0); },
    close: (code, reason) => { agent.handleTransportClose(code, reason); },
    bufferedAmount: 0,
  };
  const agentTransport: MuxTransport = {
    send: (data) => { setTimeout(() => edge.handleMessage(data), 0); },
    close: (code, reason) => { edge.handleTransportClose(code, reason); },
    bufferedAmount: 0,
  };

  edge = new Mux({ transport: edgeTransport, role: 'edge', initialStreamWindow: window });
  agent = new Mux({
    transport: agentTransport,
    role: 'agent',
    initialStreamWindow: window,
    ...agentOptions,
  });
  return { edge, agent };
}

const httpOpen = (path: string, priority: Open['priority'] = 'normal'): Open => ({
  kind: 'http',
  method: 'GET',
  path,
  headers: [['accept', 'text/html']],
  priority,
});

async function collect(stream: Stream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream.body()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('mux', () => {
  it('carries an HTTP request/response pair', async () => {
    const { edge } = pair({
      onStream: (stream: Stream) => {
        stream.sendHead({ status: 200, headers: [['content-type', 'text/plain']] });
        void stream.write(new TextEncoder().encode(`echo:${stream.open.path}`)).then(() => stream.end());
      },
    });
    const stream = edge.open(httpOpen('/hello'));
    const head = await stream.head();
    expect(head.status).toBe(200);
    expect(new TextDecoder().decode(await collect(stream))).toBe('echo:/hello');
  });

  it('honours the receive window and grants credit as the consumer reads', async () => {
    let writes: Promise<void> = Promise.resolve();
    const { edge } = pair({
      onStream: (stream: Stream) => {
        stream.sendHead({ status: 200, headers: [] });
        writes = stream.write(new Uint8Array(64 * 1024).fill(7)).then(() => stream.end());
      },
    }, 16 * 1024);

    const stream = edge.open(httpOpen('/big'));
    await stream.head();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The sender cannot have pushed more than one window ahead of the reader.
    expect(stream.bufferedBytes).toBeLessThanOrEqual(16 * 1024);

    const body = await collect(stream);
    await writes;
    expect(body.byteLength).toBe(64 * 1024);
  });

  it('keeps a half-closed stream routable while the response body streams', async () => {
    // Regression: a GET request half-closes immediately (END). The stream must
    // stay routable so the response can consume more than one window of credit.
    const payload = new Uint8Array(300_000).fill(9);
    const { edge } = pair({
      onStream: (stream: Stream) => {
        void (async () => {
          for await (const _chunk of stream.body()) {
            // No request body on a GET; draining ends the iterator.
          }
          stream.sendHead({ status: 200, headers: [['content-length', String(payload.byteLength)]] });
          await stream.write(payload);
          await stream.end();
        })();
      },
    }, 256 * 1024);

    const stream = edge.open(httpOpen('/large'));
    await stream.end();
    expect((await stream.head()).status).toBe(200);
    const body = await collect(stream);
    expect(body.byteLength).toBe(payload.byteLength);
    expect(body[0]).toBe(9);
    expect(body[payload.byteLength - 1]).toBe(9);
  });

  it('relays WebSocket frames in both directions', async () => {
    const { edge } = pair({
      onStream: (stream: Stream) => {
        stream.onFrame((opcode, data) => {
          if (opcode === 1) stream.sendFrame(1, new TextEncoder().encode(`ack:${new TextDecoder().decode(data)}`));
        });
        stream.sendOpenAck({ ok: true, protocol: 'dsh' });
      },
    });

    const stream = edge.open({ kind: 'ws', method: 'GET', path: '/api/remote.mux', headers: [], priority: 'high' });
    const frames: string[] = [];
    stream.onFrame((opcode, data) => {
      frames.push(`${String(opcode)}:${new TextDecoder().decode(data)}`);
    });
    expect(await stream.openAck()).toEqual({ ok: true, protocol: 'dsh' });
    stream.sendFrame(1, new TextEncoder().encode('ping'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toContain('1:ack:ping');
  });

  it('propagates a reset to the peer stream', async () => {
    let received: string | undefined;
    const { edge } = pair({
      onStream: (stream: Stream) => {
        stream.onReset((reset) => {
          received = reset.code;
        });
        stream.sendHead({ status: 200, headers: [] });
      },
    });
    const stream = edge.open(httpOpen('/cancel'));
    await stream.head();
    stream.reset('CLIENT_ABORTED', 'browser left');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toBe('CLIENT_ABORTED');
  });

  it('serves a high-priority stream ahead of a low-priority backlog', async () => {
    const sent: Array<{ type: number; streamId: number }> = [];
    const transport: MuxTransport = {
      send(data) {
        // Copy before the mux reuses buffers.
        const frame = decodeFrame(new Uint8Array(data));
        sent.push({ type: frame.type, streamId: frame.streamId });
      },
      close() {},
      bufferedAmount: 0,
    };
    const mux = new Mux({ transport, role: 'edge' });
    const low = mux.open(httpOpen('/assets/big.js', 'low'));
    const high = mux.open(httpOpen('/', 'high'));
    void low.write(new Uint8Array(96 * 1024));
    void high.write(new Uint8Array(1024));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstLowData = sent.findIndex((frame) => frame.type === FrameType.Data && frame.streamId === low.id);
    const firstHighData = sent.findIndex((frame) => frame.type === FrameType.Data && frame.streamId === high.id);
    expect(firstHighData).toBeGreaterThanOrEqual(0);
    expect(firstLowData).toBeGreaterThanOrEqual(0);
    expect(firstHighData).toBeLessThan(firstLowData);
  });

  it('closes the mux when the heartbeat goes stale', async () => {
    let closedCode: number | undefined;
    const transport: MuxTransport = { send() {}, close() {}, bufferedAmount: 0 };
    const mux = new Mux({
      transport,
      role: 'edge',
      heartbeatMs: 10,
      idleTimeoutMs: 25,
      onClose: (code) => {
        closedCode = code;
      },
    });
    mux.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(closedCode).toBe(4000);
  });

  it('rejects a stream when the agent has no handler', async () => {
    const { edge } = pair();
    const stream = edge.open(httpOpen('/unhandled'));
    await expect(stream.head()).rejects.toThrow(/STREAM_REJECTED/);
  });
});