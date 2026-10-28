import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCli } from '../src/main.js';
import type { AgentOptions } from '../src/types.js';

const ENV_KEYS = [
  'DSHRC_EDGE',
  'DSHRC_DSH_URL',
  'DSHRC_DSH_URL_FILE',
  'DSHRC_STATE_DIR',
  'DSHRC_NAME',
  'DSHRC_INSECURE',
  'DSHRC_STATUS_FILE',
  'DSHRC_LOG_LEVEL',
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configOf(argv: string[]): { options: AgentOptions; statusFile?: string } {
  const config = parseCli(argv);
  if (config === 'help') throw new Error('expected a config, got help');
  return config;
}

describe('agent CLI argument parsing', () => {
  it('parses every documented flag', () => {
    const config = configOf([
      '--edge',
      'https://edge.example.com',
      '--dsh-url',
      'http://127.0.0.1:4567',
      '--dsh-url-file',
      '/run/dsh-rc/dsh-url.json',
      '--state-dir',
      '/tmp/dsh-rc-state',
      '--name',
      'laptop',
      '--insecure',
      '--status-file',
      '/tmp/dsh-rc-status.json',
      '--log-level',
      'debug',
    ]);
    expect(config.options).toMatchObject({
      edgeUrl: 'https://edge.example.com',
      dshUrl: 'http://127.0.0.1:4567',
      dshUrlFile: '/run/dsh-rc/dsh-url.json',
      stateDir: '/tmp/dsh-rc-state',
      name: 'laptop',
      insecure: true,
    });
    expect(config.statusFile).toBe('/tmp/dsh-rc-status.json');
  });

  it('prefers CLI flags over environment variables', () => {
    process.env['DSHRC_EDGE'] = 'http://127.0.0.1:9999';
    process.env['DSHRC_DSH_URL'] = 'http://127.0.0.1:1111';
    process.env['DSHRC_DSH_URL_FILE'] = '/env/file.json';
    process.env['DSHRC_STATE_DIR'] = '/env/state';
    process.env['DSHRC_NAME'] = 'env-name';
    process.env['DSHRC_INSECURE'] = '1';
    process.env['DSHRC_LOG_LEVEL'] = 'error';

    const config = configOf([
      '--edge',
      'http://127.0.0.1:8787',
      '--dsh-url',
      'http://127.0.0.1:2222',
      '--state-dir',
      '/flag/state',
      '--name',
      'flag-name',
    ]);
    expect(config.options.edgeUrl).toBe('http://127.0.0.1:8787');
    expect(config.options.dshUrl).toBe('http://127.0.0.1:2222');
    expect(config.options.dshUrlFile).toBe('/env/file.json');
    expect(config.options.stateDir).toBe('/flag/state');
    expect(config.options.name).toBe('flag-name');
    expect(config.options.insecure).toBe(true);
  });

  it('falls back to environment variables and documented defaults', () => {
    process.env['DSHRC_DSH_URL_FILE'] = '/env/file.json';
    const config = configOf([]);
    expect(config.options.edgeUrl).toBe('http://127.0.0.1:8787');
    expect(config.options.dshUrlFile).toBe('/env/file.json');
    expect(config.options.dshUrl).toBe('');
    expect(config.options.stateDir).toContain('.dsh-rc');
    expect(config.options.insecure).toBeUndefined();
  });

  it('requires either --dsh-url or --dsh-url-file', () => {
    expect(() => parseCli(['--edge', 'http://127.0.0.1:8787'])).toThrow(/--dsh-url or --dsh-url-file/);
  });

  it('rejects unknown flags and invalid log levels', () => {
    expect(() => parseCli(['--nope'])).toThrow(/Usage:/);
    expect(() => parseCli(['--dsh-url', 'http://127.0.0.1:1', '--log-level', 'verbose'])).toThrow(/invalid --log-level/);
  });

  it('returns the help text for --help', () => {
    expect(parseCli(['--help'])).toBe('help');
  });
});