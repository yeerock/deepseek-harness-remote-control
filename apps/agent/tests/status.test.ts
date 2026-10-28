import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusTracker, writeStatusFileAtomic } from '../src/status.js';
import type { AgentStatus } from '../src/types.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-status-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('StatusTracker', () => {
  it('emits transitions and moves `since` only when the state changes', () => {
    const emitted: AgentStatus[] = [];
    const tracker = new StatusTracker(
      { edgeUrl: 'https://edge.example', upstream: 'http://127.0.0.1:1234' },
      (status) => emitted.push(status),
    );

    expect(tracker.value().state).toBe('starting');
    const firstSince = tracker.value().since;

    const connecting = tracker.update({ state: 'connecting', deviceId: 'dev_abcdefghijklmnopqrst' });
    expect(connecting.since).toBeGreaterThanOrEqual(firstSince);
    const connectingSince = connecting.since;

    tracker.update({ latencyMs: 12 });
    expect(tracker.value().state).toBe('connecting');
    expect(tracker.value().since).toBe(connectingSince);
    expect(tracker.value().latencyMs).toBe(12);

    tracker.update({ state: 'online', lastError: undefined });
    expect(tracker.value().state).toBe('online');
    expect(tracker.value().since).toBeGreaterThanOrEqual(connectingSince);

    expect(emitted.map((status) => status.state)).toEqual(['connecting', 'connecting', 'online']);
  });

  it('does not emit identical snapshots and survives a throwing callback', () => {
    let calls = 0;
    const tracker = new StatusTracker(
      { edgeUrl: 'https://edge.example', upstream: 'http://127.0.0.1:1234' },
      () => {
        calls += 1;
        throw new Error('consumer bug');
      },
    );
    tracker.update({ state: 'connecting' });
    tracker.update({ state: 'connecting' });
    expect(calls).toBe(1);
    expect(tracker.value().state).toBe('connecting');
  });
});

describe('atomic status file', () => {
  it('creates the directory, writes valid JSON, uses 0600 and leaves no temp files', async () => {
    const dir = await tempDir();
    const file = join(dir, 'nested', 'status.json');
    const status: AgentStatus = {
      state: 'online',
      deviceId: 'dev_abcdefghijklmnopqrst',
      pairUrl: 'https://edge.example/pair?code=abcd-efgh',
      edgeUrl: 'https://edge.example',
      reconnects: 2,
      since: 1_700_000_000_000,
      upstream: 'http://127.0.0.1:1234',
      latencyMs: 7,
    };
    writeStatusFileAtomic(file, status);

    const parsed = JSON.parse(await readFile(file, 'utf8')) as AgentStatus;
    expect(parsed).toEqual(status);

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);

    const entries = await readdir(join(dir, 'nested'));
    expect(entries).toEqual(['status.json']);

    writeStatusFileAtomic(file, { ...status, state: 'reconnecting', reconnects: 3 });
    const reparsed = JSON.parse(await readFile(file, 'utf8')) as AgentStatus;
    expect(reparsed.state).toBe('reconnecting');
    expect(reparsed.reconnects).toBe(3);
  });
});