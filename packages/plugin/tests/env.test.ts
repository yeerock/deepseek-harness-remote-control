import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentChildEnv, parseAgentStatus, resolveNodeCommand, targetFromSpec } from '../src/agent-supervisor.js';
import type { LaunchTarget } from '../src/agent-supervisor.js';

const scratch: string[] = [];

function scratchFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-link-plugin-test-'));
  scratch.push(dir);
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  return file;
}

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('agentChildEnv', () => {
  it('sets ELECTRON_RUN_AS_NODE for the Electron binary without mutating the base env', () => {
    const base = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '' };
    const target: LaunchTarget = { command: '/app/DeepSeek Harness', prefixArgs: ['main.js'], display: 'main.js', electron: true };
    const env = agentChildEnv(target, base);
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(base['ELECTRON_RUN_AS_NODE']).toBe('');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('does not add the Electron flag for a plain Node runtime', () => {
    const target: LaunchTarget = { command: '/usr/local/bin/node', prefixArgs: ['main.js'], display: 'main.js' };
    const env = agentChildEnv(target, { PATH: '/usr/bin' });
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
  });

  it('gives the runtime wrapper the Electron executable it delegates to', () => {
    const target: LaunchTarget = {
      command: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node',
      prefixArgs: [],
      display: 'main.js',
      runtimeWrapper: true,
    };
    const env = agentChildEnv(target, {});
    expect(env['DSH_DESKTOP_NODE_EXECUTABLE']).toBe(process.execPath);
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
  });
});

describe('resolveNodeCommand', () => {
  it('prefers DSH_LINK_NODE over everything else', () => {
    const node = scratchFile('node');
    const result = resolveNodeCommand({ DSH_LINK_NODE: node });
    expect(result.command).toBe(node);
    expect(result.electron).toBe(false);
  });

  it('falls back to the current executable when no override exists and marks Electron correctly', () => {
    const result = resolveNodeCommand({});
    expect(result.command).toBe(process.execPath);
    expect(result.electron).toBe(typeof process.versions.electron === 'string');
  });
});

describe('targetFromSpec', () => {
  it('runs a JavaScript entry through a Node runtime', () => {
    const entry = scratchFile('main.js');
    const target = targetFromSpec(entry, '/tmp/plugin');
    expect(target?.prefixArgs).toEqual([entry]);
    expect(target?.command).toBe(process.execPath);
  });

  it('treats a bare name as a PATH command', () => {
    const target = targetFromSpec('dsh-link', '/tmp/plugin');
    expect(target).toEqual({ command: 'dsh-link', prefixArgs: [], display: 'dsh-link' });
  });
});

describe('agent status parsing', () => {
  it('prefers the status-file pair URL and ignores junk', () => {
    expect(parseAgentStatus('not json')).toBeUndefined();
    expect(parseAgentStatus('{"state":"nope"}')).toBeUndefined();
    const status = parseAgentStatus(
      JSON.stringify({
        state: 'online',
        pairUrl: 'https://edge.example/d/dev_1',
        deviceId: 'dev_1',
        latencyMs: 12,
        reconnects: 3,
        since: 100,
        upstream: 'http://127.0.0.1:1/',
      }),
    );
    expect(status).toMatchObject({
      state: 'online',
      pairUrl: 'https://edge.example/d/dev_1',
      deviceId: 'dev_1',
      latencyMs: 12,
      reconnects: 3,
      since: 100,
    });
  });
});