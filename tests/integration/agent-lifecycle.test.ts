/**
 * Agent lifecycle contracts that the tunnel tests depend on:
 *   - one agent per state directory (O_EXCL lock), second instance errors out
 *     without disturbing the live tunnel or deleting the owner's lock;
 *   - identity is persisted 0600 inside a 0700 directory.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  browserFetch,
  loadAgentModule,
  startStack,
  type LinkStack,
} from '../harness/link.js';

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return noopLogger;
  },
};

describe('agent lifecycle', () => {
  let stack: LinkStack;

  beforeAll(async () => {
    stack = await startStack();
  }, 40_000);

  afterAll(async () => {
    await stack?.stop();
  }, 20_000);

  it('rejects a second agent on the same state directory and keeps the first online', async () => {
    const module = await loadAgentModule();
    const second = await module.startAgent({
      edgeUrl: stack.edgeUrl,
      dshUrl: stack.mock.authUrl,
      name: 'second-agent',
      stateDir: stack.agentStateDir,
      insecure: true,
      logger: noopLogger,
    });
    try {
      expect(second.status().state).toBe('error');
      expect(second.status().lastError ?? '').toMatch(/another agent is already running/i);
      expect(second.status().lastError ?? '').toMatch(/pid/i);

      // The live tunnel is untouched by the rejected second instance.
      const response = await browserFetch(stack, '/api/status');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    } finally {
      await second.stop();
    }

    // Stopping the rejected instance must not release the first agent's lock.
    const stillOnline = await browserFetch(stack, '/api/status');
    expect(stillOnline.status).toBe(200);
    expect(stack.agent.status().state).toBe('online');
  });

  it('persists the device identity with 0600 inside a 0700 state directory', async () => {
    const identity = await stat(join(stack.agentStateDir, 'device.json'));
    const directory = await stat(stack.agentStateDir);
    expect(identity.mode & 0o777).toBe(0o600);
    expect(directory.mode & 0o777).toBe(0o700);
  });
});
