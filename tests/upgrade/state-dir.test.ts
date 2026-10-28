/**
 * Upgrade path: the plugin must keep using a pre-rename `<DSH_HOME>/link` state
 * directory when `<DSH_HOME>/rc` has no identity yet; otherwise an approved
 * device would be orphaned and a new device registered on upgrade.
 *
 * This is a package-level test of the plugin's resolver (no DSH host needed).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  resolveDshHome,
  resolveStateDir,
} from '../../packages/plugin/src/config.js';

describe('plugin state-dir legacy fallback', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-rc-home-'));
    previousHome = process.env['DSH_HOME'];
    process.env['DSH_HOME'] = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['DSH_HOME'];
    else process.env['DSH_HOME'] = previousHome;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  async function writeIdentity(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'device.json'), '{"version":1}\n', { mode: 0o600 });
  }

  it('resolves <DSH_HOME> from the environment', () => {
    expect(resolveDshHome()).toBe(home);
    expect(resolveDshHome('/explicit/home')).toBe('/explicit/home');
  });

  it('uses the legacy <DSH_HOME>/link identity when <DSH_HOME>/rc has none', async () => {
    await writeIdentity(join(home, 'link'));
    expect(resolveStateDir(DEFAULT_CONFIG)).toBe(join(home, 'link'));
  });

  it('prefers the modern <DSH_HOME>/rc identity when both exist', async () => {
    await writeIdentity(join(home, 'link'));
    await writeIdentity(join(home, 'rc'));
    expect(resolveStateDir(DEFAULT_CONFIG)).toBe(join(home, 'rc'));
  });

  it('returns the modern <DSH_HOME>/rc path when neither identity exists', async () => {
    await mkdir(join(home, 'link'), { recursive: true }); // empty legacy dir
    expect(resolveStateDir(DEFAULT_CONFIG)).toBe(join(home, 'rc'));
  });

  it('honours an explicit config.stateDir over DSH_HOME', async () => {
    const explicit = join(home, 'custom-state');
    await writeIdentity(join(home, 'link'));
    expect(resolveStateDir({ ...DEFAULT_CONFIG, stateDir: explicit })).toBe(join(explicit, 'rc'));
    await writeIdentity(join(explicit, 'link'));
    expect(resolveStateDir({ ...DEFAULT_CONFIG, stateDir: explicit })).toBe(join(explicit, 'link'));
  });
});
