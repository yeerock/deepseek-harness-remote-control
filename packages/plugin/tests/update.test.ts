import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNewerVersion, UpdateManager, versionParts } from '../src/update.js';

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
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reports idle when the release is current', async () => {
    const manager = new UpdateManager({
      repoRoot: '/nonexistent',
      currentVersion: '0.2.2',
      fetchImpl: (async () => new Response(JSON.stringify({ tag_name: 'v0.2.2' }), { status: 200 })) as typeof fetch,
    });
    const state = await manager.check();
    expect(state.state).toBe('idle');
    expect(state.latest).toBe('0.2.2');
  });

  it('refuses to install when the checkout has no self-update script', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dshrc-update-'));
    const manager = new UpdateManager({
      repoRoot: dir,
      currentVersion: '0.2.2',
      fetchImpl: (async () => new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 })) as typeof fetch,
    });
    const state = await manager.check();
    expect(state.state).toBe('error');
    expect(state.latest).toBe('9.9.9');
    expect(state.message).toContain('self-update.sh');
  });

  it('surfaces a GitHub failure without throwing', async () => {
    const manager = new UpdateManager({
      repoRoot: '/nonexistent',
      currentVersion: '0.2.2',
      fetchImpl: (async () => new Response('rate limited', { status: 403 })) as typeof fetch,
    });
    const state = await manager.check();
    expect(state.state).toBe('error');
    expect(state.message).toContain('403');
  });
});