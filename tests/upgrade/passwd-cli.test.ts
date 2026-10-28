/**
 * Password rotation CLI (`dsh-rc-edge-passwd`): copy an edge DB, rotate, and
 * prove through the real login form that the old password fails and the new
 * one succeeds. Short passwords and a database with no owner must exit non-zero
 * without changing anything.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CookieJar,
  OWNER_PASSWORD,
  REPO_ROOT,
  rawRequest,
  startEdge,
  ownerSetup,
  type EdgeProcess,
} from '../harness/link.js';

const PASSWD_ENTRY = join(REPO_ROOT, 'apps', 'edge', 'src', 'passwd.ts');
const OLD_PASSWORD = OWNER_PASSWORD;
const NEW_PASSWORD = 'rotated-password-456';

interface LoginAttempt {
  status: number;
  location: string | undefined;
  bodyText: string;
  jar: CookieJar;
}

async function loginAttempt(edgeUrl: string, password: string): Promise<LoginAttempt> {
  const jar = new CookieJar();
  const page = await rawRequest(edgeUrl, { path: '/login', headers: { accept: 'text/html' } });
  jar.absorb(page.setCookies);
  const csrf = jar.get('dshrc_csrf') ?? '';
  const response = await rawRequest(edgeUrl, {
    method: 'POST',
    path: '/login',
    headers: {
      cookie: jar.header() ?? '',
      origin: edgeUrl,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    },
    body: `csrf=${encodeURIComponent(csrf)}&password=${encodeURIComponent(password)}`,
  });
  jar.absorb(response.setCookies);
  return {
    status: response.status,
    location: typeof response.headers['location'] === 'string' ? response.headers['location'] : undefined,
    bodyText: response.bodyText,
    jar,
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runPasswd(dataDir: string, password: string | undefined): Promise<CliResult> {
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', PASSWD_ENTRY, '--data-dir', dataDir], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...(password === undefined ? {} : { DSHRC_NEW_PASSWORD: password }),
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`passwd CLI timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('dsh-rc-edge-passwd', () => {
  let root: string;
  let originalDir: string;
  let rotatedDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rc-passwd-'));
    originalDir = join(root, 'edge-original');
    rotatedDir = join(root, 'edge-rotated');
    const edge = await startEdge({ dataDir: originalDir, setupCode: 'setup-passwd-1' });
    try {
      await ownerSetup(edge.url, 'setup-passwd-1', OLD_PASSWORD);
    } finally {
      await edge.stop();
    }
    await cp(originalDir, rotatedDir, { recursive: true });
  }, 40_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('rotates the owner password so the old one fails and the new one works', async () => {
    const cli = await runPasswd(rotatedDir, NEW_PASSWORD);
    // Node 22 prints an ExperimentalWarning for node:sqlite; only our own
    // errors matter here.
    expect(cli.stderr).not.toContain('dsh-rc passwd:');
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain('owner password updated');

    let edge: EdgeProcess | undefined;
    try {
      edge = await startEdge({ dataDir: rotatedDir, setupCode: 'ignored-on-existing-db' });
      const oldLogin = await loginAttempt(edge.url, OLD_PASSWORD);
      expect(oldLogin.status).toBe(403);
      expect(oldLogin.bodyText).toContain('Incorrect password');

      const newLogin = await loginAttempt(edge.url, NEW_PASSWORD);
      expect(newLogin.status).toBe(303);
      expect(newLogin.location).toBe('/');
      expect(newLogin.jar.get('dshrc_session')).toBeDefined();

      const dashboard = await rawRequest(edge.url, {
        path: '/',
        headers: { cookie: newLogin.jar.header() ?? '', accept: 'text/html' },
      });
      expect(dashboard.status).toBe(200);
    } finally {
      await edge?.stop();
    }
  }, 30_000);

  it('rejects a short password with a non-zero exit and no update', async () => {
    const cli = await runPasswd(rotatedDir, 'too-short');
    expect(cli.code).not.toBe(0);
    expect(cli.stderr).toMatch(/12-256 characters/);
    expect(cli.stdout).not.toContain('owner password updated');

    // The previous rotation must still be the effective password.
    let edge: EdgeProcess | undefined;
    try {
      edge = await startEdge({ dataDir: rotatedDir, setupCode: 'ignored-on-existing-db' });
      expect((await loginAttempt(edge.url, NEW_PASSWORD)).status).toBe(303);
    } finally {
      await edge?.stop();
    }
  }, 30_000);

  it('exits non-zero when the database has no owner', async () => {
    // A real edge DB schema with no owner row (first boot, setup not completed).
    const noOwnerDir = join(root, 'edge-no-owner');
    const edge = await startEdge({ dataDir: noOwnerDir, setupCode: 'setup-passwd-unused' });
    await edge.stop();
    const cli = await runPasswd(noOwnerDir, NEW_PASSWORD);
    expect(cli.code).not.toBe(0);
    expect(cli.stderr).toMatch(/no owner/i);
    expect(cli.stdout).not.toContain('owner password updated');
  }, 30_000);

  it('is packaged as the dsh-rc-edge-passwd binary', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'apps', 'edge', 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(manifest.bin?.['dsh-rc-edge-passwd']).toBe('./dist/passwd.js');
  });
});
