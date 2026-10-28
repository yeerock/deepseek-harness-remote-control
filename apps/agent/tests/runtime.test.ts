import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@dsh-rc/shared';
import { startAgent } from '../src/index.js';
import { AgentRuntime } from '../src/runtime.js';
import type { AgentOptions, AgentStatus } from '../src/types.js';
import { identityPath } from '../src/identity.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import { MockDsh } from './helpers/mock-dsh.js';
import { MockEdge, waitUntil, type EdgeTunnel } from './helpers/mock-edge.js';
import { captureLogger, readBody, startTestAgent, states, type TestAgent } from './helpers/agent.js';

interface Harness {
  dsh: MockDsh;
  edge: MockEdge;
  agent: TestAgent;
  tunnel: EdgeTunnel | undefined;
}

let harness: Harness | undefined;
const extraCleanups: Array<() => Promise<void>> = [];
const extraStateDirs: string[] = [];

async function setup(options: { autoApprove?: boolean } = {}): Promise<Harness> {
  const dsh = new MockDsh({ token: 'launch-secret' });
  await dsh.start();
  const edge = new MockEdge({ autoApprove: options.autoApprove ?? true });
  await edge.start();
  try {
    const agent = await startTestAgent({ edgeUrl: edge.url, dshUrl: dsh.authenticatedUrl });
    let tunnel: EdgeTunnel | undefined;
    if (options.autoApprove !== false) {
      await agent.agent.waitForOnline(8_000);
      tunnel = await edge.waitForTunnel();
    }
    harness = { dsh, edge, agent, tunnel };
    return harness;
  } catch (error) {
    await edge.stop();
    await dsh.stop();
    throw error;
  }
}

afterEach(async () => {
  const current = harness;
  harness = undefined;
  if (current !== undefined) {
    await current.agent.cleanup();
    await current.edge.stop();
    await current.dsh.stop();
  }
  for (const cleanup of extraCleanups.splice(0)) await cleanup();
  for (const dir of extraStateDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitForDone(runtime: AgentRuntime, timeoutMs = 5_000): Promise<void> {
  await Promise.race([
    runtime.done,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for terminal state')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

describe('Agent public API and status transitions', () => {
  it('startAgent → online → stop, with a status stream that never leaks the launch token', async () => {
    const dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    const edge = new MockEdge({ autoApprove: true });
    await edge.start();
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-rc-runtime-'));
    extraStateDirs.push(stateDir);
    const statuses: AgentStatus[] = [];

    const handle = await startAgent({
      edgeUrl: edge.url,
      dshUrl: dsh.authenticatedUrl,
      name: 'unit-test',
      stateDir,
      logger: createLogger('test', 'silent'),
      onStatus: (status) => statuses.push(status),
    });
    try {
      await handle.waitForOnline(8_000);
      const status = handle.status();
      expect(status.state).toBe('online');
      expect(status.deviceId).toMatch(/^dev_[a-z0-9]{16,64}$/);
      expect(status.edgeUrl).toBe(edge.url);
      expect(status.upstream).toBe(dsh.url);
      expect(status.reconnects).toBe(0);
      expect(status.pairUrl).toContain('/pair?code=');
      expect(JSON.stringify(statuses)).not.toContain('launch-secret');
      expect(states(statuses)).toEqual(expect.arrayContaining(['starting', 'pairing', 'connecting', 'online']));

      // status() is live: the device identity was persisted with 0600.
      expect((await stat(identityPath(stateDir))).mode & 0o777).toBe(0o600);
      const identity = JSON.parse(await readFile(identityPath(stateDir), 'utf8')) as { deviceId: string; approvedAt?: number };
      expect(identity.deviceId).toBe(status.deviceId);
      expect(identity.approvedAt).toBeTypeOf('number');
    } finally {
      await handle.stop();
      await dsh.stop();
      await edge.stop();
    }
    expect(handle.status().state).toBe('stopped');
  });

  it('holds the state-dir lock while running and removes it on stop', async () => {
    const { agent } = await setup();
    const lockPath = join(agent.stateDir, LOCK_FILE_NAME);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    const info = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(info.pid).toBe(process.pid);

    await agent.agent.stop();
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('refuses to start a second agent for the same state dir', async () => {
    const dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    const edge = new MockEdge({ autoApprove: true });
    await edge.start();
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-rc-runtime-'));
    extraStateDirs.push(stateDir);
    const held = { pid: process.pid, startedAt: Date.now(), host: hostname() };
    await writeFile(join(stateDir, LOCK_FILE_NAME), JSON.stringify(held), { mode: 0o600 });

    try {
      const runtime = await AgentRuntime.start({
        edgeUrl: edge.url,
        dshUrl: dsh.authenticatedUrl,
        stateDir,
        logger: createLogger('test', 'silent'),
      });
      await waitForDone(runtime);
      const status = runtime.status();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('another agent is already running');
      expect(status.lastError).toContain(`pid ${String(process.pid)}`);
      expect(edge.registerCount).toBe(0);

      const info = JSON.parse(await readFile(join(stateDir, LOCK_FILE_NAME), 'utf8')) as { startedAt: number };
      expect(info.startedAt).toBe(held.startedAt);
    } finally {
      await edge.stop();
      await dsh.stop();
    }
  });

  it('waits in pairing with a pair URL until the owner approves', async () => {
    const { edge, agent } = await setup({ autoApprove: false });
    const status = agent.agent.status();
    expect(status.state).toBe('pairing');
    expect(status.pairUrl).toContain('/pair?code=');

    const device = edge.device;
    expect(device).toBeDefined();
    edge.approve(device?.deviceId ?? '');
    await agent.agent.waitForOnline(8_000);
    expect(agent.agent.status().state).toBe('online');
    expect(edge.mePollCount).toBeGreaterThan(0);
  });
});

describe('reconnection', () => {
  it('reconnects after a transport drop and reports the reconnect count', async () => {
    const { edge, agent } = await setup();
    expect(agent.agent.status().reconnects).toBe(0);

    edge.dropTunnel();
    await edge.waitForTunnelCount(2, 8_000);
    await waitUntil(() => agent.agent.status().state === 'online', 8_000, 'online after reconnect');
    expect(agent.agent.status().reconnects).toBeGreaterThanOrEqual(1);
    expect(states(agent.statuses)).toContain('reconnecting');
  });

  it('reconnects with backoff on 4004 TUNNEL_BUSY instead of exiting', async () => {
    const { edge, agent } = await setup();
    const before = edge.tunnelConnectCount;
    edge.closeTunnel(4004, 'TUNNEL_BUSY: replaced by a newer tunnel');

    await edge.waitForTunnelCount(before + 1, 8_000);
    await waitUntil(() => agent.agent.status().state === 'online', 8_000, 'online after 4004');
    expect(agent.agent.status().state).toBe('online');
    expect(agent.agent.status().reconnects).toBeGreaterThanOrEqual(1);
    expect(states(agent.statuses)).toContain('reconnecting');
  });

  it('polls for approval when the edge answers HELLO with DEVICE_PENDING', async () => {
    const { edge, agent } = await setup();
    const device = edge.device;
    expect(device).toBeDefined();
    if (device === undefined) return;

    device.status = 'pending';
    edge.dropTunnel();
    await waitUntil(() => edge.mePollCount > 0, 8_000, 'approval poll');
    await waitUntil(() => agent.agent.status().state === 'pairing', 5_000, 'pairing again');

    edge.approve(device.deviceId);
    await waitUntil(() => agent.agent.status().state === 'online', 8_000, 'online after approval');
  });

  it('stops retrying when the device is revoked (close code 4003)', async () => {
    const { edge, agent } = await setup();
    const connectionsBefore = edge.tunnelConnectCount;
    edge.closeTunnel(4003, 'revoked by owner');
    await waitForDone(agent.agent);
    const status = agent.agent.status();
    expect(status.state).toBe('error');
    expect(status.lastError?.toLowerCase()).toContain('revoked');

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(edge.tunnelConnectCount).toBe(connectionsBefore);
  });

  it('stops immediately on a terminal HELLO_ACK failure (AUTH_FAILED)', async () => {
    const dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    const edge = new MockEdge({ autoApprove: true, helloFailure: { code: 'AUTH_FAILED', message: 'secret mismatch' } });
    await edge.start();
    const testAgent = await startTestAgent({ edgeUrl: edge.url, dshUrl: dsh.authenticatedUrl });
    try {
      await waitForDone(testAgent.agent);
      const status = testAgent.agent.status();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('AUTH_FAILED');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(edge.tunnelConnectCount).toBe(1);
      expect(edge.helloRejections).toBe(1);
    } finally {
      await testAgent.cleanup();
      await edge.stop();
      await dsh.stop();
    }
  });

  it('rejects waitForOnline when the device is revoked while pairing', async () => {
    const { edge, agent } = await setup({ autoApprove: false });
    const device = edge.device;
    expect(device).toBeDefined();
    if (device === undefined) return;
    const waiting = agent.agent.waitForOnline(5_000);
    edge.revoke(device.deviceId);
    await expect(waiting).rejects.toThrow(/revoked|authorised|authorized/i);
    await waitForDone(agent.agent);
    expect(agent.agent.status().state).toBe('error');
  });
});

describe('pair URL log hygiene', () => {
  it('keeps the pair URL and pair code out of logs while exposing them in status', async () => {
    const dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    const edge = new MockEdge({ autoApprove: true });
    await edge.start();
    const { logger, lines } = captureLogger();
    const testAgent = await startTestAgent({ edgeUrl: edge.url, dshUrl: dsh.authenticatedUrl, logger });
    try {
      await testAgent.agent.waitForOnline(8_000);
      const pairUrl = testAgent.agent.status().pairUrl;
      expect(pairUrl).toBeDefined();
      if (pairUrl === undefined) return;
      const code = new URL(pairUrl).searchParams.get('code');
      expect(code).not.toBeNull();

      const logText = lines.join('\n');
      expect(logText).not.toContain(pairUrl);
      expect(logText).not.toContain(code ?? '__missing__');
    } finally {
      await testAgent.cleanup();
      await edge.stop();
      await dsh.stop();
    }
  });
});

describe('identity reuse across restarts', () => {
  it('reuses the persisted device instead of registering twice', async () => {
    const dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    const edge = new MockEdge({ autoApprove: true });
    await edge.start();
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-rc-runtime-'));
    extraStateDirs.push(stateDir);
    const options: AgentOptions = {
      edgeUrl: edge.url,
      dshUrl: dsh.authenticatedUrl,
      stateDir,
      name: 'reused',
      logger: createLogger('test', 'silent'),
    };
    try {
      const first = await AgentRuntime.start(options, { pairPollMs: 50, connectTimeoutMs: 3_000 });
      await first.waitForOnline(8_000);
      expect(edge.registerCount).toBe(1);
      await first.stop();

      const second = await AgentRuntime.start(options, { pairPollMs: 50, connectTimeoutMs: 3_000 });
      await second.waitForOnline(8_000);
      expect(edge.registerCount).toBe(1);
      expect(second.status().deviceId).toBe(first.status().deviceId);
      await second.stop();
    } finally {
      await edge.stop();
      await dsh.stop();
    }
  });
});

describe('dshUrlFile precedence and secret hygiene', () => {
  it('reads the authenticated URL from a 0600 file and prefers it over dshUrl', async () => {
    const dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    const edge = new MockEdge({ autoApprove: true });
    await edge.start();
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-rc-runtime-'));
    extraStateDirs.push(stateDir);
    const urlFileDir = await mkdtemp(join(tmpdir(), 'dsh-rc-urlfile-'));
    const urlFile = join(urlFileDir, 'dsh-url.json');
    await writeFile(urlFile, JSON.stringify({ url: dsh.authenticatedUrl }), { mode: 0o600 });
    extraCleanups.push(async () => rm(urlFileDir, { recursive: true, force: true }));

    const testAgent = await startTestAgent({
      edgeUrl: edge.url,
      // Deliberately wrong origin: the file must win.
      dshUrl: 'http://127.0.0.1:1',
      dshUrlFile: urlFile,
    });
    try {
      await testAgent.agent.waitForOnline(8_000);
      const stream = edge.openHttp({
        kind: 'http',
        method: 'GET',
        path: '/',
        headers: [['accept', 'text/html']],
        priority: 'high',
      });
      expect((await stream.head()).status).toBe(200);
      expect((await readBody(stream)).toString('utf8')).toContain('dsh-home');
      const serialized = JSON.stringify(testAgent.agent.status());
      expect(serialized).not.toContain('launch-secret');
      expect(serialized).not.toContain('dsh_session');
      expect(testAgent.agent.status().upstream).toBe(dsh.url);
    } finally {
      await testAgent.cleanup();
      await edge.stop();
      await dsh.stop();
    }
  });

  it('refuses a non-loopback dshUrl', async () => {
    await expect(
      AgentRuntime.start({
        edgeUrl: 'http://127.0.0.1:8787',
        dshUrl: 'http://example.com:8080/',
        stateDir: join(tmpdir(), 'dsh-rc-never-created'),
        logger: createLogger('test', 'silent'),
      }),
    ).rejects.toThrow(/local DSH server/);
  });
});