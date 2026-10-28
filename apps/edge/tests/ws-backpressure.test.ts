import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Stream } from '@dsh-link/mux';
import type { Reset } from '@dsh-link/protocol';
import {
  MAX_BROWSER_WS_BUFFERED_BYTES,
  MAX_TUNNEL_QUEUED_FRAMES,
  browserBackpressureExceeded,
  tunnelBackpressureExceeded,
} from '../src/proxy-ws.js';
import {
  TEST_SETUP_CODE,
  connectTunnel,
  provisionDevice,
  setupOwner,
  startEdge,
  type TestEdge,
} from './helpers.js';

const MiB = 1024 * 1024;
const edges: TestEdge[] = [];

afterEach(async () => {
  for (const edge of edges.splice(0)) await edge.close();
});

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface ChildEdge {
  url: string;
  pid: number;
  stop: () => Promise<void>;
}

/**
 * Boot the edge as its own process so the RSS assertion measures the edge and
 * not the test's in-process fake agent and browser.
 */
async function startChildEdge(): Promise<ChildEdge> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dshlink-edge-rss-'));
  const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const repoRoot = path.resolve(path.dirname(entry), '..', '..', '..');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      entry,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      dataDir,
      '--insecure',
      '--setup-code',
      TEST_SETUP_CODE,
      '--log-level',
      'silent',
    ],
    { cwd: repoRoot, env: { ...process.env, DSHLINK_SETUP_CODE: TEST_SETUP_CODE }, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as unknown as ChildProcessWithoutNullStreams;

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await rm(dataDir, { recursive: true, force: true });
  };

  try {
    const url = await waitFor(
      () => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1],
      15_000,
      'child edge to listen',
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error('child edge has no pid');
    return { url, pid, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function processRssBytes(pid: number): number {
  const raw = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const kib = Number(raw.split(/\s+/)[0]);
  if (!Number.isFinite(kib) || kib <= 0) throw new Error(`could not read RSS for pid ${String(pid)}`);
  return kib * 1024;
}

describe('websocket backpressure limits', () => {
  it('uses the documented thresholds', () => {
    expect(browserBackpressureExceeded(MAX_BROWSER_WS_BUFFERED_BYTES)).toBe(false);
    expect(browserBackpressureExceeded(MAX_BROWSER_WS_BUFFERED_BYTES + 1)).toBe(true);
    expect(tunnelBackpressureExceeded(MAX_TUNNEL_QUEUED_FRAMES)).toBe(false);
    expect(tunnelBackpressureExceeded(MAX_TUNNEL_QUEUED_FRAMES + 1)).toBe(true);
  });

  it('resets a stream with WS_BACKPRESSURE when the browser stops reading, and RSS stays sublinear', async () => {
    const child = await startChildEdge();
    let agent: Awaited<ReturnType<typeof connectTunnel>> | undefined;
    try {
      const owner = await setupOwner(child.url);
      const { device } = await provisionDevice(child.url, owner.jar);
      const agentStreams: Stream[] = [];
      agent = await connectTunnel(child.url, device.deviceId, device.deviceSecret, {
        onStream: (stream) => {
          agentStreams.push(stream);
          stream.sendOpenAck({ ok: true });
        },
      });

      const rssBefore = processRssBytes(child.pid);
      let totalSent = 0;

      // First the 32 MiB burst from the requirement, then a 64 MiB burst on a
      // fresh stream. If the edge buffered linearly, RSS would grow by ~96 MiB.
      for (const burstBytes of [32 * MiB, 64 * MiB]) {
        let resetInfo: Reset | undefined;
        const browser = new WebSocket(`${child.url.replace(/^http/, 'ws')}/d/${device.deviceId}/api/remote.mux`, {
          headers: { cookie: owner.jar.header() },
        });
        try {
          await new Promise<void>((resolve, reject) => {
            browser.once('open', resolve);
            browser.once('error', reject);
            browser.once('unexpected-response', (_request, response) => reject(new Error(`upgrade ${String(response.statusCode)}`)));
          });
          const index = agentStreams.length - 1;
          const stream = await waitFor(() => agentStreams[index], 2_000, 'agent stream');
          stream.onReset((reset) => {
            resetInfo = reset;
          });
          const browserSocket = (browser as unknown as { _socket?: import('node:net').Socket })._socket;
          expect(browserSocket).toBeDefined();
          browserSocket?.pause();

          const chunk = Buffer.alloc(64 * 1024 - 16, 0x41);
          const frames = Math.ceil(burstBytes / chunk.byteLength);
          let bytesSent = 0;
          for (let frame = 0; frame < frames; frame += 1) {
            if (resetInfo !== undefined) break;
            stream.sendFrame(2, chunk);
            bytesSent += chunk.byteLength;
            await new Promise((resolve) => setImmediate(resolve));
            if (frame % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
          }
          const reset = await waitFor(() => resetInfo, 5_000, 'WS_BACKPRESSURE reset');
          expect(reset.code).toBe('WS_BACKPRESSURE');
          expect(reset.retryable).toBe(true);
          // Cut before the whole burst is queued: memory is bounded, not linear.
          expect(bytesSent).toBeLessThan(burstBytes);
          totalSent += bytesSent;

          // Let the forced terminate release the wedged browser before the next
          // burst and before the RSS sample.
          await new Promise((resolve) => setTimeout(resolve, 500));
          browserSocket?.resume();
        } finally {
          try {
            browser.terminate();
          } catch {
            /* already gone */
          }
        }
      }

      const rssGrowth = processRssBytes(child.pid) - rssBefore;
      // 96 MiB was pushed from the agent; a linear buffer would exceed this.
      expect(totalSent).toBeLessThan(96 * MiB);
      expect(rssGrowth).toBeLessThan(64 * MiB);
    } finally {
      await agent?.close();
      await child.stop();
    }
  });

  it('resets WS_BACKPRESSURE when browser frames would grow the tunnel queue without bound', async () => {
    const edge = await startEdge();
    edges.push(edge);
    const owner = await setupOwner(edge.base);
    const { device } = await provisionDevice(edge.base, owner.jar);

    let agentStream: Stream | undefined;
    let resetInfo: Reset | undefined;
    const agent = await connectTunnel(edge.base, device.deviceId, device.deviceSecret, {
      onStream: (stream) => {
        agentStream = stream;
        stream.sendOpenAck({ ok: true });
        // Consume frames so the mux does not trip its own early-frame cap; this
        // test is about the edge scheduler's backpressure.
        stream.onFrame(() => undefined);
        stream.onReset((reset) => {
          resetInfo = reset;
        });
      },
    });

    const browser = new WebSocket(`${edge.base.replace(/^http/, 'ws')}/d/${device.deviceId}/api/remote.mux`, {
      headers: { cookie: owner.jar.header() },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        browser.once('open', resolve);
        browser.once('error', reject);
        browser.once('unexpected-response', (_request, response) => reject(new Error(`upgrade ${String(response.statusCode)}`)));
      });
      expect(agentStream).toBeDefined();

      // Stop the agent reading its tunnel; browser frames then pile up in the
      // edge mux scheduler instead of crossing the wire.
      const agentSocket = (agent.ws as unknown as { _socket?: import('node:net').Socket })._socket;
      expect(agentSocket).toBeDefined();
      agentSocket?.pause();

      const chunk = Buffer.alloc(8 * 1024, 0x42);
      for (let index = 0; index < 1_600; index += 1) {
        if (browser.readyState !== WebSocket.OPEN) break;
        browser.send(chunk);
        if (index % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
      }

      const closeCode = await new Promise<number>((resolve) => {
        browser.once('close', (code) => resolve(code));
        setTimeout(() => resolve(-1), 5_000).unref();
      });
      expect(closeCode).not.toBe(-1);

      agentSocket?.resume();
      const reset = await waitFor(() => resetInfo, 5_000, 'WS_BACKPRESSURE reset');
      expect(reset.code).toBe('WS_BACKPRESSURE');
      expect(reset.retryable).toBe(true);
    } finally {
      try {
        browser.terminate();
      } catch {
        /* already gone */
      }
      await agent.close();
    }
  });
});