import { afterEach, describe, expect, it } from 'vitest';
import { sanitizePairUrl } from '../src/edge-client.js';
import { MockDsh } from './helpers/mock-dsh.js';
import { MockEdge } from './helpers/mock-edge.js';
import { captureLogger, startTestAgent, type TestAgent } from './helpers/agent.js';

const EDGE = 'https://edge.example.com';

describe('pair URL sanitizer', () => {
  it('accepts a single-line, same-origin http(s) pair URL', () => {
    expect(sanitizePairUrl('https://edge.example.com/pair?code=abcd-efgh', EDGE)).toBe('https://edge.example.com/pair?code=abcd-efgh');
    expect(sanitizePairUrl('http://127.0.0.1:8787/pair?code=x', 'http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/pair?code=x');
  });

  it('drops javascript:, cross-origin, credential-bearing and oversized URLs', () => {
    expect(sanitizePairUrl('javascript:alert(1)', EDGE)).toBeUndefined();
    expect(sanitizePairUrl('https://evil.example/pair?code=x', EDGE)).toBeUndefined();
    expect(sanitizePairUrl('https://user:pass@edge.example.com/pair', EDGE)).toBeUndefined();
    expect(sanitizePairUrl(`https://edge.example.com/${'a'.repeat(2048)}`, EDGE)).toBeUndefined();
    expect(sanitizePairUrl('not a url', EDGE)).toBeUndefined();
    expect(sanitizePairUrl(undefined, EDGE)).toBeUndefined();
  });

  it('rejects newline/control-character injection from a compromised edge', () => {
    const injected = 'https://edge.example.com/pair?code=x\nDSHRC_PAIR_URL=javascript:alert(1)';
    expect(sanitizePairUrl(injected, EDGE)).toBeUndefined();
    expect(sanitizePairUrl('https://edge.example.com/pair?code=x\r\nInjected: yes', EDGE)).toBeUndefined();
    expect(sanitizePairUrl('https://edge.example.com/pair?code=x\u0000', EDGE)).toBeUndefined();
  });

  it('never logs the rejected value', () => {
    const lines: string[] = [];
    const logger = {
      debug: (message: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ message, fields })),
      info: (message: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ message, fields })),
      warn: (message: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ message, fields })),
      error: (message: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ message, fields })),
      child: () => logger,
    };
    sanitizePairUrl('javascript:evil()', EDGE, logger);
    expect(lines.join('\n')).not.toContain('javascript:evil');
    expect(lines.join('\n')).toContain('non-http(s) pair URL');
  });
});

describe('malicious edge pair URL integration', () => {
  let agent: TestAgent | undefined;
  let edge: MockEdge | undefined;
  let dsh: MockDsh | undefined;

  afterEach(async () => {
    if (agent !== undefined) await agent.cleanup();
    if (edge !== undefined) await edge.stop();
    if (dsh !== undefined) await dsh.stop();
    agent = undefined;
    edge = undefined;
    dsh = undefined;
  });

  it('drops an injected pair URL but keeps pairing with a device id', async () => {
    dsh = new MockDsh({ token: 'launch-secret' });
    await dsh.start();
    edge = new MockEdge({ autoApprove: false, pairUrlOverride: 'https://evil.example/pair?code=x\nEVIL' });
    await edge.start();
    const { logger, lines } = captureLogger();
    agent = await startTestAgent({ edgeUrl: edge.url, dshUrl: dsh.authenticatedUrl, logger });

    const status = agent.agent.status();
    expect(status.state).toBe('pairing');
    expect(status.deviceId).toBeDefined();
    expect(status.pairUrl).toBeUndefined();
    expect(agent.statuses.every((entry) => entry.pairUrl === undefined)).toBe(true);
    expect(lines.join('\n')).not.toContain('evil.example');
    expect(lines.join('\n')).not.toContain('EVIL');
  });
});
