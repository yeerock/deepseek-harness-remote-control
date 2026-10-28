import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_FILE_NAME, acquireInstanceLock } from '../src/lock.js';
import { TerminalAgentError } from '../src/errors.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rc-lock-'));
  tempDirs.push(dir);
  return dir;
}

async function writeLock(stateDir: string, info: { pid: number; startedAt: number; host: string }): Promise<void> {
  await writeFile(join(stateDir, LOCK_FILE_NAME), `${JSON.stringify(info)}\n`, { mode: 0o600 });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('single-instance state directory lock', () => {
  it('acquires with O_EXCL, records pid/startedAt/host at 0600, and releases idempotently', async () => {
    const stateDir = await tempDir();
    const lock = acquireInstanceLock(stateDir);
    const path = join(stateDir, LOCK_FILE_NAME);

    expect(lock.path).toBe(path);
    const info = JSON.parse(await readFile(path, 'utf8')) as { pid: number; startedAt: number; host: string };
    expect(info.pid).toBe(process.pid);
    expect(info.startedAt).toBeTypeOf('number');
    expect(info.host).toBe(hostname());
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    lock.release();
    await expect(stat(path)).rejects.toThrow();
    expect(() => lock.release()).not.toThrow();
  });

  it('refuses to start when a live agent owns the lock for this state dir', async () => {
    const stateDir = await tempDir();
    await writeLock(stateDir, { pid: process.pid, startedAt: Date.now(), host: hostname() });
    const path = join(stateDir, LOCK_FILE_NAME);
    const before = await readFile(path, 'utf8');

    expect(() => acquireInstanceLock(stateDir)).toThrow(TerminalAgentError);
    try {
      acquireInstanceLock(stateDir);
    } catch (error) {
      expect((error as Error).message).toContain('another agent is already running');
      expect((error as Error).message).toContain(`pid ${String(process.pid)}`);
      expect((error as TerminalAgentError).code).toBe('AGENT_ALREADY_RUNNING');
    }
    // The live holder's file is untouched.
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('takes over a lock whose PID is dead', async () => {
    const stateDir = await tempDir();
    await writeLock(stateDir, { pid: 2_000_000_000, startedAt: Date.now(), host: hostname() });
    const lock = acquireInstanceLock(stateDir);
    try {
      const info = JSON.parse(await readFile(join(stateDir, LOCK_FILE_NAME), 'utf8')) as { pid: number };
      expect(info.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('takes over a lock older than 24 hours even when the PID is still alive', async () => {
    const stateDir = await tempDir();
    const startedAt = Date.now() - 25 * 60 * 60 * 1000;
    await writeLock(stateDir, { pid: process.pid, startedAt, host: hostname() });
    const lock = acquireInstanceLock(stateDir);
    try {
      const info = JSON.parse(await readFile(join(stateDir, LOCK_FILE_NAME), 'utf8')) as { startedAt: number };
      expect(info.startedAt).toBeGreaterThan(startedAt);
    } finally {
      lock.release();
    }
  });

  it('takes over a corrupt lock file instead of blocking forever', async () => {
    const stateDir = await tempDir();
    await writeFile(join(stateDir, LOCK_FILE_NAME), 'not-json', { mode: 0o600 });
    const lock = acquireInstanceLock(stateDir);
    try {
      const info = JSON.parse(await readFile(join(stateDir, LOCK_FILE_NAME), 'utf8')) as { pid: number };
      expect(info.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('never deletes a lock that was taken over by someone else', async () => {
    const stateDir = await tempDir();
    const lock = acquireInstanceLock(stateDir);
    const path = join(stateDir, LOCK_FILE_NAME);
    const other = { pid: process.pid, startedAt: Date.now() + 1, host: hostname() };
    await writeFile(path, `${JSON.stringify(other)}\n`, { mode: 0o600 });

    lock.release();
    const info = JSON.parse(await readFile(path, 'utf8')) as { startedAt: number };
    expect(info.startedAt).toBe(other.startedAt);
  });
});