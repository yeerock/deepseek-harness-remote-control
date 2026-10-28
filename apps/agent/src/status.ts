/**
 * Status tracking: immutable snapshots, transition notifications and the
 * atomic JSON status file the DSH plugin polls.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@dsh-link/shared';
import type { AgentState, AgentStatus } from './types.js';

let statusFileCounter = 0;

export class StatusTracker {
  private current: AgentStatus;
  private readonly onStatus: ((status: AgentStatus) => void) | undefined;
  private readonly logger: Logger | undefined;

  constructor(init: { edgeUrl: string; upstream: string }, onStatus?: (status: AgentStatus) => void, logger?: Logger) {
    this.onStatus = onStatus;
    this.logger = logger;
    this.current = {
      state: 'starting',
      edgeUrl: init.edgeUrl,
      reconnects: 0,
      since: Date.now(),
      upstream: init.upstream,
    };
  }

  value(): AgentStatus {
    return this.current;
  }

  /** Emit the current snapshot once, e.g. right after construction. */
  announce(): AgentStatus {
    this.emit(this.current);
    return this.current;
  }

  /**
   * Merge a patch. `since` moves only when the state changes; identical
   * snapshots are not emitted, so consumers see transitions rather than noise.
   */
  update(patch: Partial<AgentStatus> & { state?: AgentState }): AgentStatus {
    const stateChanged = patch.state !== undefined && patch.state !== this.current.state;
    const next: AgentStatus = {
      ...this.current,
      ...patch,
      since: stateChanged ? Date.now() : this.current.since,
    };
    // Drop keys explicitly set to undefined so JSON and equality stay tidy.
    for (const key of Object.keys(next) as Array<keyof AgentStatus>) {
      if (next[key] === undefined) delete next[key];
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    if (changed) this.emit(next);
    return next;
  }

  private emit(status: AgentStatus): void {
    try {
      this.onStatus?.(status);
    } catch (error) {
      this.logger?.warn('onStatus callback threw; ignoring', { error });
    }
  }
}

/** Write the status file atomically (tmp + rename) with mode 0600. */
export function writeStatusFileAtomic(filePath: string, status: AgentStatus): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  statusFileCounter = (statusFileCounter + 1) % 1_000_000;
  const temporary = `${filePath}.${String(process.pid)}.${String(statusFileCounter)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* the temporary file may not exist */
    }
    throw error;
  }
}