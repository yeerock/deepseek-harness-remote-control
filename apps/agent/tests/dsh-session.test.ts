import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockDsh } from './helpers/mock-dsh.js';
import {
  DshSession,
  cookieHeaderFromSetCookie,
  parseDshUrl,
  readDshUrlFile,
} from '../src/dsh-session.js';
import { AUTHENTICATION_HINT, TerminalAgentError } from '../src/errors.js';

let dsh: MockDsh;
let stateDir: string | undefined;

beforeEach(async () => {
  dsh = new MockDsh({ token: 'launch-secret' });
  await dsh.start();
});

afterEach(async () => {
  await dsh.stop();
  if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

describe('parseDshUrl', () => {
  it('accepts loopback http and extracts the launch token from the query', () => {
    const parsed = parseDshUrl(`http://127.0.0.1:4567/?token=abc`);
    expect(parsed.target.origin).toBe('http://127.0.0.1:4567');
    expect(parsed.target.host).toBe('127.0.0.1');
    expect(parsed.target.port).toBe(4567);
    expect(parsed.target.hostHeader).toBe('127.0.0.1:4567');
    expect(parsed.token).toBe('abc');
  });

  it('accepts localhost and IPv6 loopback without putting the token in the origin', () => {
    expect(parseDshUrl('http://localhost:9000/?token=x').target.origin).toBe('http://localhost:9000');
    const v6 = parseDshUrl('http://[::1]:9000/');
    expect(v6.target.origin).toBe('http://[::1]:9000');
    expect(v6.target.hostHeader).toBe('[::1]:9000');
  });

  it('redacts the raw URL when it cannot be parsed (token leak)', () => {
    try {
      parseDshUrl('not a url?token=SECRET-TOKEN-VALUE');
    } catch (error) {
      expect((error as Error).message).toBe('invalid dshUrl (redacted)');
      expect((error as Error).message).not.toContain('SECRET-TOKEN-VALUE');
      expect((error as Error).message).not.toContain('not a url');
    }
    expect(() => parseDshUrl('not a url?token=SECRET-TOKEN-VALUE')).toThrow(/invalid dshUrl \(redacted\)/);
  });

  it('rejects non-loopback targets, credentials and bad protocols', () => {
    expect(() => parseDshUrl('http://example.com:1234/')).toThrow(TerminalAgentError);
    expect(() => parseDshUrl('http://user:pass@127.0.0.1:1234/')).toThrow(TerminalAgentError);
    expect(() => parseDshUrl('ftp://127.0.0.1:1234/')).toThrow(TerminalAgentError);
    expect(() => parseDshUrl('not a url')).toThrow(TerminalAgentError);
  });

  it('lets an explicit token override the URL token', () => {
    expect(parseDshUrl('http://127.0.0.1:1/?token=url-token', 'explicit').token).toBe('explicit');
  });
});

describe('cookieHeaderFromSetCookie', () => {
  it('keeps only name=value pairs and joins multiple cookies', () => {
    expect(cookieHeaderFromSetCookie(['a=1; Path=/; HttpOnly', 'b=2; Secure'])).toBe('a=1; b=2');
    expect(cookieHeaderFromSetCookie([])).toBeUndefined();
    expect(cookieHeaderFromSetCookie(['invalid'])).toBeUndefined();
  });
});

describe('DshSession token exchange', () => {
  it('exchanges the token once, does not follow the 303, and reuses the cookie', async () => {
    const session = new DshSession({ dshUrl: dsh.authenticatedUrl });
    const cookie = await session.cookie();
    expect(cookie).toBe('dsh_session=s1');
    expect(session.hasCookie).toBe(true);
    expect(dsh.exchangeCount).toBe(1);
    // Only the exchange request was made: the 303 was not followed.
    expect(dsh.requests).toHaveLength(1);
    expect(dsh.requests[0]?.path).toBe('/?token=launch-secret');

    expect(await session.cookie()).toBe('dsh_session=s1');
    expect(dsh.exchangeCount).toBe(1);
  });

  it('refreshes on demand after the upstream invalidates the cookie', async () => {
    const session = new DshSession({ dshUrl: dsh.authenticatedUrl });
    expect(await session.cookie()).toBe('dsh_session=s1');
    dsh.invalidateCookies();
    expect(dsh.validCookies.size).toBe(0);

    expect(await session.refresh()).toBe(true);
    expect(await session.cookie()).toBe('dsh_session=s2');
    expect(dsh.exchangeCount).toBe(2);
  });

  it('deduplicates concurrent refreshes', async () => {
    const session = new DshSession({ dshUrl: dsh.authenticatedUrl });
    await session.cookie();
    const results = await Promise.all([session.refresh(), session.refresh(), session.refresh()]);
    expect(results).toEqual([true, true, true]);
    expect(dsh.exchangeCount).toBe(2);
  });

  it('returns no cookie and performs no exchange when there is no token', async () => {
    const session = new DshSession({ dshUrl: dsh.url });
    expect(session.canAuthenticate).toBe(false);
    expect(await session.cookie()).toBeUndefined();
    expect(await session.refresh()).toBe(false);
    expect(dsh.exchangeCount).toBe(0);
  });

  it('fails with an actionable auth error when the token is rejected', async () => {
    const session = new DshSession({ dshUrl: `${dsh.url}/?token=wrong` });
    await expect(session.cookie()).rejects.toThrow(AUTHENTICATION_HINT);
    expect(dsh.exchangeCount).toBe(1);
  });
});

describe('readDshUrlFile', () => {
  it('reads the url from a 0600 JSON file without logging it', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'dsh-link-urlfile-'));
    const file = join(stateDir, 'dsh-url.json');
    await writeFile(file, JSON.stringify({ url: dsh.authenticatedUrl }), { mode: 0o600 });
    expect(readDshUrlFile(file)).toBe(dsh.authenticatedUrl);
  });

  it('rejects missing, malformed and key-less files without leaking contents', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'dsh-link-urlfile-'));
    const missing = join(stateDir, 'missing.json');
    expect(() => readDshUrlFile(missing)).toThrow(TerminalAgentError);

    const malformed = join(stateDir, 'bad.json');
    await writeFile(malformed, '{not json', { mode: 0o600 });
    expect(() => readDshUrlFile(malformed)).toThrow(/not valid JSON/);

    const keyless = join(stateDir, 'keyless.json');
    await writeFile(keyless, JSON.stringify({ token: 'leak-me' }), { mode: 0o600 });
    expect(() => readDshUrlFile(keyless)).toThrow(/"url" string/);
    try {
      readDshUrlFile(keyless);
    } catch (error) {
      expect((error as Error).message).not.toContain('leak-me');
    }
  });
});