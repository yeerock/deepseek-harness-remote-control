import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCli } from '../src/main.js';
import type { AgentOptions } from '../src/types.js';

const ENV_KEYS = [
  'DSH_LINK_EDGE',
  'DSH_LINK_DSH_URL',
  'DSH_LINK_DSH_URL_FILE',
  'DSH_LINK_STATE_DIR',
  'DSH_LINK_NAME',
  'DSH_LINK_INSECURE',
  'DSH_LINK_STATUS_FILE',
  'DSH_LINK_LOG_LEVEL',
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
      '/run/dsh-link/dsh-url.json',
      '--state-dir',
      '/tmp/dsh-link-state',
      '--name',
      'laptop',
      '--insecure',
      '--status-file',
      '/tmp/dsh-link-status.json',
      '--log-level',
      'debug',
    ]);
    expect(config.options).toMatchObject({
      edgeUrl: 'https://edge.example.com',
      dshUrl: 'http://127.0.0.1:4567',
      dshUrlFile: '/run/dsh-link/dsh-url.json',
      stateDir: '/tmp/dsh-link-state',
      name: 'laptop',
      insecure: true,
    });
    expect(config.statusFile).toBe('/tmp/dsh-link-status.json');
  });

  it('prefers CLI flags over environment variables', () => {
    process.env['DSH_LINK_EDGE'] = 'http://127.0.0.1:9999';
    process.env['DSH_LINK_DSH_URL'] = 'http://127.0.0.1:1111';
    process.env['DSH_LINK_DSH_URL_FILE'] = '/env/file.json';
    process.env['DSH_LINK_STATE_DIR'] = '/env/state';
    process.env['DSH_LINK_NAME'] = 'env-name';
    process.env['DSH_LINK_INSECURE'] = '1';
    process.env['DSH_LINK_LOG_LEVEL'] = 'error';

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
    process.env['DSH_LINK_DSH_URL_FILE'] = '/env/file.json';
    const config = configOf([]);
    expect(config.options.edgeUrl).toBe('http://127.0.0.1:8787');
    expect(config.options.dshUrlFile).toBe('/env/file.json');
    expect(config.options.dshUrl).toBe('');
    expect(config.options.stateDir).toContain('.dsh-link');
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