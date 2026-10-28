/**
 * Single-instance lock per state directory.
 *
 * Two agents sharing one device identity would fight for the same tunnel: the
 * edge replaces the older socket (close 4004), the supervisor restarts it, and
 * the user sees the "disconnects easily" failure this project exists to avoid.
 * A lock file next to `device.json` makes that impossible.
 *
 * Acquisition is O_EXCL. A lock whose owner PID is gone (or whose file is more
 * than 24 h old) is stale and is taken over once.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@dsh-link/shared';
import { TerminalAgentError } from './errors.js';

export const LOCK_FILE_NAME = 'agent.lock';
export const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

export interface LockInfo {
  pid: number;
  startedAt: number;
  host: string;
}

export interface InstanceLock {
  readonly path: string;
  readonly info: LockInfo;
  /** Remove the lock if it is still ours. Idempotent and ENOENT-safe. */
  release(): void;
}

function sleepSync(ms: number): void {
  // Atomics.wait is the only synchronous sleep available on the main thread;
  // it is used only for a sub-50 ms re-read after a lock file was observed
  // mid-write, never in a hot path.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLock(text: string): LockInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const pid = record['pid'];
  const startedAt = record['startedAt'];
  const host = record['host'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  return { pid, startedAt, host: typeof host === 'string' ? host : '' };
}

interface ExistingLock {
  info: LockInfo | undefined;
  ageMs: number;
}

function readExisting(path: string, now: number): ExistingLock | undefined {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(path, 'utf8');
    mtimeMs = statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let info = parseLock(text);
  if (info === undefined) {
    // The creator may still be between open(O_EXCL) and write(); give it one
    // short synchronous grace period before calling the file corrupt.
    sleepSync(25);
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    info = parseLock(text);
  }
  const reference = info?.startedAt ?? mtimeMs;
  return { info, ageMs: Math.max(0, now - reference) };
}

function describeHolder(entry: ExistingLock): string {
  if (entry.info === undefined) return 'lock file is unreadable';
  return `pid ${String(entry.info.pid)} on ${entry.info.host === '' ? 'unknown host' : entry.info.host}`;
}

/**
 * Acquire the per-state-dir lock or throw a terminal error naming the holder.
 * `stateDir` must already exist (the runtime ensures that via the identity
 * module before calling us).
 */
export function acquireInstanceLock(
  stateDir: string,
  options: { logger?: Logger; now?: () => number; staleMs?: number } = {},
): InstanceLock {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, LOCK_FILE_NAME);
  const now = options.now ?? (() => Date.now());
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const info: LockInfo = { pid: process.pid, startedAt: now(), host: hostname() };
  const payload = `${JSON.stringify(info)}\n`;

  const tryCreate = (): boolean => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, payload, { encoding: 'utf8' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          /* ignore */
        }
      }
    }
  };

  const acquire = (): InstanceLock => {
    if (tryCreate()) {
      options.logger?.debug('state directory lock acquired', { path, pid: info.pid });
      return {
        path,
        info,
        release: () => releaseInstanceLock(path, info),
      };
    }

    const existing = readExisting(path, now());
    if (existing !== undefined) {
      const sameHost = existing.info !== undefined && existing.info.host === info.host;
      const alive = existing.info !== undefined && sameHost && processIsAlive(existing.info.pid);
      const stale = existing.ageMs > staleMs || (existing.info !== undefined && !alive && sameHost) || existing.info === undefined;
      if (!stale) {
        throw new TerminalAgentError(
          'AGENT_ALREADY_RUNNING',
          `another agent is already running for this state dir (${describeHolder(existing)})`,
        );
      }
      options.logger?.warn('taking over a stale agent lock', { path, holder: describeHolder(existing), ageMs: existing.ageMs });
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    // Retry exactly once after the takeover to close the ENOENT/race window.
    if (tryCreate()) {
      options.logger?.debug('state directory lock acquired after takeover', { path, pid: info.pid });
      return {
        path,
        info,
        release: () => releaseInstanceLock(path, info),
      };
    }
    const raced = readExisting(path, now());
    throw new TerminalAgentError(
      'AGENT_ALREADY_RUNNING',
      `another agent is already running for this state dir (${raced === undefined ? 'lock reappeared' : describeHolder(raced)})`,
    );
  };

  return acquire();
}

/** Remove the lock only if the file still contains our own identity. */
export function releaseInstanceLock(path: string, info: LockInfo): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return;
  }
  const current = parseLock(text);
  if (current === undefined || current.pid !== info.pid || current.startedAt !== info.startedAt || current.host !== info.host) {
    // Someone took over; never delete their lock.
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}