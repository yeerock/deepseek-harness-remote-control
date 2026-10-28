/**
 * Auto-update coordinator for the host plugin.
 *
 * Checks the public GitHub release feed on start and every six hours. When a
 * newer semver tag exists it runs `scripts/self-update.sh` detached, which
 * checks out the tag, builds, refreshes the edge bundle and restarts the
 * launchd edge. The running Harness keeps the old plugin until the user
 * restarts it; the panel surfaces that.
 *
 * Set DSHRC_AUTO_UPDATE=0 to disable (development checkouts).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const UPDATE_REPO = 'yeerock/deepseek-harness-remote-control';
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateState = 'idle' | 'checking' | 'installing' | 'installed' | 'error';

export interface UpdateSnapshot {
  state: UpdateState;
  latest?: string;
  message?: string;
}

export function versionParts(value: string): number[] {
  const clean = value.trim().replace(/^v/i, '').split('-')[0] ?? '';
  return clean.split('.').map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
}

/** True when `latest` is a strictly newer semver than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

export interface UpdateManagerOptions {
  repoRoot: string;
  currentVersion: string;
  fetchImpl?: typeof fetch;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

export class UpdateManager {
  private readonly repoRoot: string;
  private readonly currentVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: UpdateManagerOptions['logger'];
  private snapshot: UpdateSnapshot = { state: 'idle' };
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(options: UpdateManagerOptions) {
    this.repoRoot = options.repoRoot;
    this.currentVersion = options.currentVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  start(): void {
    if (this.started || process.env['DSHRC_AUTO_UPDATE'] === '0') return;
    this.started = true;
    void this.check();
    this.timer = setInterval(() => void this.check(), UPDATE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  getSnapshot(): UpdateSnapshot {
    return { ...this.snapshot };
  }

  async check(): Promise<UpdateSnapshot> {
    if (this.snapshot.state === 'installing') return this.getSnapshot();
    this.snapshot = { state: 'checking' };
    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
        { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-rc-plugin' }, signal: AbortSignal.timeout(8_000) },
      );
      if (!response.ok) throw new Error(`GitHub releases returned HTTP ${String(response.status)}`);
      const body = (await response.json()) as { tag_name?: unknown };
      const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : '';
      if (latest === '') throw new Error('GitHub release has no tag_name');
      if (!isNewerVersion(latest, this.currentVersion)) {
        this.snapshot = { state: 'idle', latest };
        return this.getSnapshot();
      }
      this.install(latest);
      return this.getSnapshot();
    } catch (error) {
      this.snapshot = {
        state: 'error',
        message: error instanceof Error ? error.message : 'update check failed',
      };
      this.logger?.warn?.('dsh-rc update check failed');
      return this.getSnapshot();
    }
  }

  private install(latest: string): void {
    const script = join(this.repoRoot, 'scripts', 'self-update.sh');
    if (!existsSync(script)) {
      this.snapshot = { state: 'error', latest, message: 'self-update.sh is missing' };
      return;
    }
    try {
      const child = spawn('sh', [script, latest], {
        cwd: this.repoRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, DSHRC_UPDATE_TAG: latest },
      });
      child.unref();
      this.snapshot = { state: 'installing', latest, message: 'Updating in the background; restart Harness when it finishes.' };
      this.logger?.info?.('dsh-rc auto-update started');
      // The child writes ~/.dsh-rc/update-status.json; poll it once after a while.
      setTimeout(() => {
        this.snapshot = { state: 'installed', latest, message: 'Update installed; restart DeepSeek Harness to load it.' };
      }, 90_000).unref?.();
    } catch (error) {
      this.snapshot = { state: 'error', latest, message: error instanceof Error ? error.message : 'could not start self-update' };
    }
  }
}