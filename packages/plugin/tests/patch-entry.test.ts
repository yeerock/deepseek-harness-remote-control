import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error plain .mjs helper shared with scripts/join-edge.mjs
import { dshRcPatchEntry } from '../../../scripts/lib/patch-entry.mjs';

describe('cordis.patch.yml entry', () => {
  it('keeps a Windows agent path exact (\\U used to break the YAML and stop DeepSeek Harness)', () => {
    const agentEntry = 'C:\\Users\\admin\\dsh-rc\\apps\\agent\\dist\\main.js';
    const text = dshRcPatchEntry({ edge: 'https://dsh-rc.example.ts.net', deviceName: 'Peter-Portable', agentEntry });
    const [entry] = parse(text, { strict: true }) as Array<{ id: string; config: Record<string, unknown> }>;
    expect(entry?.id).toBe('dsh-rc');
    expect(entry?.config).toMatchObject({ enabled: true, autoStart: true, agentEntry, deviceName: 'Peter-Portable', edgeUrl: 'https://dsh-rc.example.ts.net' });
  });

  it('keeps names with quotes, backslashes and unicode safe', () => {
    const text = dshRcPatchEntry({ edge: 'https://e', deviceName: 'Alex\'s "PC" \\ 电脑\nx', agentEntry: '/Users/a b/dsh-rc/main.js' });
    const [entry] = parse(text, { strict: true }) as Array<{ config: Record<string, unknown> }>;
    expect(entry?.config['deviceName']).toBe("Alex's PC \\ 电脑x");
    expect(entry?.config['agentEntry']).toBe('/Users/a b/dsh-rc/main.js');
  });
});
