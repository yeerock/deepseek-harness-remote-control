import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_FILE_NAME, identityPath, loadIdentity, saveIdentity, type DeviceIdentity } from '../src/identity.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-identity-'));
  tempDirs.push(dir);
  return dir;
}

function identity(overrides: Partial<DeviceIdentity> = {}): DeviceIdentity {
  return {
    version: 1,
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceSecret: 'super-secret-device-token',
    edgeUrl: 'https://edge.example',
    name: 'laptop',
    pairUrl: 'https://edge.example/pair?code=abcd-efgh',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('device identity persistence', () => {
  it('round-trips the identity with 0600 file mode and 0700 directory', async () => {
    const dir = await tempDir();
    const stateDir = join(dir, 'state');
    saveIdentity(stateDir, identity());

    const file = identityPath(stateDir);
    expect(file.endsWith(DEVICE_FILE_NAME)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(stateDir)).toEqual([DEVICE_FILE_NAME]);

    const loaded = loadIdentity(stateDir);
    expect(loaded).toEqual(identity());
  });

  it('tightens a lax mode and keeps the secret out of the filename', async () => {
    const dir = await tempDir();
    const file = join(dir, 'device.json');
    await writeFile(file, JSON.stringify(identity()), { mode: 0o644 });
    const loaded = loadIdentity(dir);
    expect(loaded?.deviceId).toBe('dev_abcdefghijklmnopqrst');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('treats a corrupt or truncated identity as absent', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, DEVICE_FILE_NAME), '{"version":1,"deviceId":');
    expect(loadIdentity(dir)).toBeUndefined();

    await writeFile(join(dir, DEVICE_FILE_NAME), JSON.stringify({ version: 1, deviceId: 'not-a-device' }));
    expect(loadIdentity(dir)).toBeUndefined();
  });

  it('does not leave temporary files behind', async () => {
    const dir = await tempDir();
    saveIdentity(dir, identity());
    saveIdentity(dir, identity({ name: 'renamed' }));
    const entries = await readdir(dir);
    expect(entries).toEqual([DEVICE_FILE_NAME]);
    const parsed = JSON.parse(await readFile(identityPath(dir), 'utf8')) as DeviceIdentity;
    expect(parsed.name).toBe('renamed');
  });
});