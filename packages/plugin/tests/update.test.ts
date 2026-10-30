import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevelopmentCheckout, isNewerVersion, UpdateManager, versionParts, windowsRestartScript } from '../src/update.js';

describe('update version comparison', () => {
  it('parses v-prefixed semver', () => {
    expect(versionParts('v0.2.2')).toEqual([0, 2, 2]);
    expect(versionParts('1.10.0-beta.1')).toEqual([1, 10, 0]);
  });

  it('only treats strictly newer versions as updates', () => {
    expect(isNewerVersion('0.2.2', '0.2.1')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.2.9')).toBe(true);
    expect(isNewerVersion('0.2.1', '0.2.1')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.2.1')).toBe(false);
    expect(isNewerVersion('v0.10.0', '0.9.9')).toBe(true);
  });
});

describe('update manager', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const release = (tag: string) => (async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 })) as typeof fetch;

  /** A release checkout (not on a branch) plus a private state dir. */
  function setup(head = '0123456789abcdef\n'): { repo: string; state: string } {
    dir = mkdtempSync(join(tmpdir(), 'dshrc-update-'));
    const repo = join(dir, 'repo');
    const state = join(dir, 'state');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(state);
    writeFileSync(join(repo, '.git', 'HEAD'), head);
    return { repo, state };
  }

  function installed(state: string, to: string, at = Date.now() + 1): void {
    writeFileSync(join(state, 'update-status.json'), JSON.stringify({ state: 'installed', to, at }));
  }

  it('reports idle when the release is current', async () => {
    const { repo, state } = setup();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v0.2.2') });
    const snapshot = await manager.check();
    expect(snapshot.state).toBe('idle');
    expect(snapshot.latest).toBe('0.2.2');
    expect(snapshot.checkedAt).toBeTypeOf('number');
  });

  it('never updates a development checkout on a branch', async () => {
    const { repo, state } = setup();
    rmSync(join(repo, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    expect(isDevelopmentCheckout(repo)).toBe(true);
    const spawnInstaller = vi.fn();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v9.9.9'), spawnInstaller });
    expect((await manager.check()).state).toBe('development');
    expect(spawnInstaller).not.toHaveBeenCalled();
  });

  it('refuses to install when the checkout has no updater script', async () => {
    const { repo, state } = setup();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v9.9.9') });
    const snapshot = await manager.check(true);
    expect(snapshot.state).toBe('error');
    expect(snapshot.latest).toBe('9.9.9');
    expect(snapshot.message).toContain('setup prompt');
  });

  it('ignores a release tag that is not plain semver', async () => {
    const { repo, state } = setup();
    const spawnInstaller = vi.fn();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v9.9.9; rm -rf /'), spawnInstaller });
    expect((await manager.check()).state).toBe('error');
    expect(spawnInstaller).not.toHaveBeenCalled();
  });

  it('surfaces a GitHub limit without throwing', async () => {
    const { repo, state } = setup();
    const manager = new UpdateManager({
      repoRoot: repo, stateDir: state, currentVersion: '0.2.2',
      fetchImpl: (async () => new Response('rate limited', { status: 403 })) as typeof fetch,
    });
    const snapshot = await manager.check();
    expect(snapshot.state).toBe('error');
    expect(snapshot.message).toContain('limiting');
  });

  it('waits for an idle moment before installing', async () => {
    const { repo, state } = setup();
    let idle = false;
    const spawnInstaller = vi.fn();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v0.3.0'), spawnInstaller, isIdle: async () => idle });
    expect((await manager.check()).state).toBe('available');
    await manager.tick();
    expect(spawnInstaller).not.toHaveBeenCalled();
    idle = true;
    await manager.tick();
    expect(spawnInstaller).toHaveBeenCalledWith('v0.3.0');
    expect(manager.getSnapshot().state).toBe('installing');
    manager.stop();
  });

  it('keeps a waiting update when a later check fails, and replaces it with a newer release', async () => {
    const { repo, state } = setup();
    let feed: typeof fetch = release('v0.3.0');
    const spawnInstaller = vi.fn();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: ((...a: Parameters<typeof fetch>) => feed(...a)) as typeof fetch, spawnInstaller, isIdle: async () => true });
    await manager.check(true);
    installed(state, 'v0.3.0');
    manager.pollInstaller('0.3.0');
    feed = (async () => new Response('down', { status: 500 })) as typeof fetch;
    expect((await manager.check()).state).toBe('ready');
    feed = release('v0.3.0');
    expect((await manager.check()).state).toBe('ready');
    feed = release('v0.4.0');
    await manager.check();
    expect(spawnInstaller).toHaveBeenLastCalledWith('v0.4.0');
    manager.stop();
  });

  it('does not retry a failed release automatically, only on request', async () => {
    const { repo, state } = setup();
    writeFileSync(join(state, 'update-status.json'), JSON.stringify({ state: 'error', to: 'v0.3.0', at: 1 }));
    const spawnInstaller = vi.fn();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v0.3.0'), spawnInstaller, isIdle: async () => true });
    manager.start();
    expect((await manager.check()).message).toContain('Check for Updates');
    expect(spawnInstaller).not.toHaveBeenCalled();
    await manager.check(true);
    expect(spawnInstaller).toHaveBeenCalledWith('v0.3.0');
    manager.stop();
  });

  it('installs a newer release on request, then becomes ready from the installer status', async () => {
    const { repo, state } = setup();
    const spawnInstaller = vi.fn();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v0.3.0'), spawnInstaller });
    expect((await manager.check(true)).state).toBe('installing');
    expect(spawnInstaller).toHaveBeenCalledWith('v0.3.0');
    // A stale status from an older run is not mistaken for this one.
    installed(state, 'v0.3.0', 1);
    manager.pollInstaller('0.3.0');
    expect(manager.getSnapshot().state).toBe('installing');
    // Another run holding the lock only says it is busy; keep waiting.
    writeFileSync(join(state, 'update-status.json'), JSON.stringify({ state: 'busy', to: 'v0.3.0', at: Date.now() + 1 }));
    manager.pollInstaller('0.3.0');
    expect(manager.getSnapshot().state).toBe('installing');
    writeFileSync(join(state, 'update-status.json'), JSON.stringify({ state: 'installed', to: 'v0.3.0', at: Date.now() + 1, stashed: true, message: 'Update installed. Local edits in /x were set aside with git stash (git stash list shows them).' }));
    manager.pollInstaller('0.3.0');
    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', message: expect.stringContaining('git stash') });
    // No second install while one is waiting.
    await manager.check();
    expect(spawnInstaller).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it('reports a failed install with the installer message', async () => {
    const { repo, state } = setup();
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v0.3.0'), spawnInstaller: vi.fn() });
    await manager.check(true);
    writeFileSync(join(state, 'update-status.json'), JSON.stringify({ state: 'error', to: 'v0.3.0', at: Date.now() + 1, message: 'Update to v0.3.0 failed: npm (kept the current version)' }));
    manager.pollInstaller('0.3.0');
    expect(manager.getSnapshot()).toMatchObject({ state: 'error', message: expect.stringContaining('kept the current version') });
    manager.stop();
  });

  it('restarts only when idle, and at most twice per release', async () => {
    const { repo, state } = setup();
    let idle = false;
    const restartHarness = vi.fn(() => true);
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v0.3.0'), spawnInstaller: vi.fn(), restartHarness, isIdle: async () => idle });
    await manager.check(true);
    installed(state, 'v0.3.0');
    manager.pollInstaller('0.3.0');

    await manager.restartIfIdle();
    expect(restartHarness).not.toHaveBeenCalled();

    idle = true;
    await manager.restartIfIdle();
    expect(restartHarness).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().state).toBe('restarting');
    expect(JSON.parse(readFileSync(join(state, 'update-restarts.json'), 'utf8'))).toMatchObject({ version: '0.3.0', attempts: 1 });

    // The restart did not load the new version: a fresh process sees it pending again.
    const again = () => new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: release('v0.3.0'), restartHarness, isIdle: async () => true });
    const second = again();
    second.start();
    expect(second.getSnapshot().state).toBe('ready');
    await second.restartIfIdle();
    second.stop();
    const third = again();
    third.start();
    await third.restartIfIdle();
    third.stop();
    expect(restartHarness).toHaveBeenCalledTimes(2);
    expect(third.getSnapshot().message).toContain('Restart to Update');
  });

  it('recovers from a restart that never happened, and keeps checking for releases', async () => {
    const { repo, state } = setup();
    let clock = 1_000_000;
    let feed = 'v0.3.0';
    const restartHarness = vi.fn(() => true);
    installed(state, 'v0.3.0');
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', fetchImpl: (async () => new Response(JSON.stringify({ tag_name: feed }), { status: 200 })) as unknown as typeof fetch, spawnInstaller: vi.fn(), restartHarness, isIdle: async () => true, now: () => clock });
    manager.start();
    await manager.restartIfIdle();
    expect(manager.getSnapshot().state).toBe('restarting');
    writeFileSync(join(state, 'restart-helper.log'), 'restart requested\ncould not find the DeepSeek Harness program\n');
    // Before the timeout, nothing changes.
    clock += 60_000;
    await manager.tick();
    expect(manager.getSnapshot().state).toBe('restarting');
    // After it, the restart counts as failed and is retried once (cap of two).
    clock += 3 * 60_000;
    await manager.tick();
    expect(restartHarness).toHaveBeenCalledTimes(2);
    clock += 4 * 60_000;
    await manager.tick();
    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', message: expect.stringContaining('restart-helper.log') });
    // A peer cannot get around the cap with repeated Update That Computer presses.
    expect(() => manager.restartForPeer()).toThrow(/restart twice/);
    expect(restartHarness).toHaveBeenCalledTimes(2);
    // A newer release is still noticed and installed (it used to be skipped forever).
    feed = 'v0.4.0';
    await manager.check(true);
    expect(manager.getSnapshot()).toMatchObject({ state: 'installing', latest: '0.4.0' });
    manager.stop();
  });

  it('writes a Windows restart script with safely quoted paths', () => {
    const script = windowsRestartScript("C:\\Users\\o'brien\\.dsh-rc\\restart-helper.log", 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe');
    expect(script).toContain("$log = 'C:\\Users\\o''brien\\.dsh-rc\\restart-helper.log'");
    expect(script).toContain("$fallback = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'");
    expect(script).toContain('Start-Process -FilePath $exe');
    expect(script).not.toContain('/T');
  });

  it('lets the user restart while a session is running', async () => {
    const { repo, state } = setup();
    const restartHarness = vi.fn(() => true);
    installed(state, 'v0.3.0');
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', restartHarness, isIdle: async () => false });
    manager.start();
    await manager.restartIfIdle();
    expect(restartHarness).not.toHaveBeenCalled();
    expect(manager.restartNow().state).toBe('restarting');
    manager.stop();
  });

  it('respects DSHRC_AUTO_RESTART=0', async () => {
    vi.stubEnv('DSHRC_AUTO_RESTART', '0');
    const { repo, state } = setup();
    const restartHarness = vi.fn(() => true);
    installed(state, 'v0.3.0');
    const manager = new UpdateManager({ repoRoot: repo, stateDir: state, currentVersion: '0.2.2', restartHarness, isIdle: async () => true });
    manager.start();
    await manager.restartIfIdle();
    expect(restartHarness).not.toHaveBeenCalled();
    manager.stop();
  });
});

describe('update manager races', () => {
  it('starts one installer when the hourly check and the idle tick overlap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshrc-update-race-'));
    try {
      mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
      const spawnInstaller = vi.fn();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const manager = new UpdateManager({
        repoRoot: join(dir, 'repo'), stateDir: dir, currentVersion: '0.2.2', spawnInstaller,
        fetchImpl: (async () => new Response(JSON.stringify({ tag_name: 'v0.3.0' }), { status: 200 })) as typeof fetch,
        isIdle: async () => { await gate; return true; },
      });
      const first = manager.check();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = manager.tick();
      release();
      await Promise.all([first, second]);
      expect(spawnInstaller).toHaveBeenCalledTimes(1);
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('update progress', () => {
  it('passes the installer percent through while installing, and drops it once ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshrc-update-pct-'));
    try {
      mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
      const manager = new UpdateManager({
        repoRoot: join(dir, 'repo'), stateDir: dir, currentVersion: '0.2.2', spawnInstaller: vi.fn(),
        fetchImpl: (async () => new Response(JSON.stringify({ tag_name: 'v0.3.0' }), { status: 200 })) as typeof fetch,
      });
      await manager.check(true);
      writeFileSync(join(dir, 'update-status.json'), JSON.stringify({ state: 'installing', to: 'v0.3.0', at: Date.now() + 1, percent: 65 }));
      manager.pollInstaller('0.3.0');
      expect(manager.getSnapshot()).toMatchObject({ state: 'installing', percent: 65 });
      writeFileSync(join(dir, 'update-status.json'), JSON.stringify({ state: 'installed', to: 'v0.3.0', at: Date.now() + 1 }));
      manager.pollInstaller('0.3.0');
      expect(manager.getSnapshot().state).toBe('ready');
      expect(manager.getSnapshot().percent).toBeUndefined();
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
