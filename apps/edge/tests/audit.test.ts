import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUDIT_RETENTION_DAYS, loadConfig } from '../src/config.js';
import { createEdgeServer, type EdgeServer } from '../src/server.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

async function bootIn(dataDir: string, auditRetentionDays: number): Promise<EdgeServer> {
  const config = loadConfig({
    argv: [
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      dataDir,
      '--insecure',
      '--log-level',
      'silent',
      '--audit-retention-days',
      String(auditRetentionDays),
    ],
    env: {},
  });
  const edge = createEdgeServer({ config });
  await edge.listen();
  return edge;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dshrc-audit-'));
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('audit retention', () => {
  it('prunes rows older than the retention window on boot', async () => {
    const dir = await tempDir();
    const first = await bootIn(dir, 1);
    first.db.addAudit({ event: 'ancient', ts: Date.now() - 2 * DAY_MS });
    first.db.addAudit({ event: 'fresh', ts: Date.now() });
    await first.close();

    const second = await bootIn(dir, 1);
    try {
      const events = second.db.listAudit(50).map((row) => row.event);
      expect(events).not.toContain('ancient');
      expect(events).toContain('fresh');
    } finally {
      await second.close();
    }
  });

  it('keeps every row when retention is disabled with 0', async () => {
    const dir = await tempDir();
    const first = await bootIn(dir, 0);
    first.db.addAudit({ event: 'ancient', ts: Date.now() - 2 * DAY_MS });
    await first.close();

    const second = await bootIn(dir, 0);
    try {
      expect(second.db.listAudit(50).map((row) => row.event)).toContain('ancient');
    } finally {
      await second.close();
    }
  });

  it('parses the flag and env var, defaults to 30 days, and rejects bad values', () => {
    const base = ['--port', '0', '--insecure'];
    expect(loadConfig({ argv: base, env: {} }).auditRetentionDays).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(loadConfig({ argv: [...base, '--audit-retention-days', '7'], env: {} }).auditRetentionDays).toBe(7);
    expect(loadConfig({ argv: base, env: { DSHRC_AUDIT_RETENTION_DAYS: '14' } }).auditRetentionDays).toBe(14);
    // CLI wins over env.
    expect(
      loadConfig({ argv: [...base, '--audit-retention-days', '3'], env: { DSHRC_AUDIT_RETENTION_DAYS: '14' } })
        .auditRetentionDays,
    ).toBe(3);
    expect(() => loadConfig({ argv: [...base, '--audit-retention-days', '-1'], env: {} })).toThrow(/audit-retention-days/);
    expect(() => loadConfig({ argv: [...base, '--audit-retention-days', 'soon'], env: {} })).toThrow(/audit-retention-days/);
    expect(() => loadConfig({ argv: [...base, '--audit-retention-days', '999999'], env: {} })).toThrow(/audit-retention-days/);
  });
});