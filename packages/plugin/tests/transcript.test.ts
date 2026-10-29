import { describe, expect, it } from 'vitest';
import { buildTranscript, isSessionId } from '../src/transcript.js';

const ev = (seq: number, type: string, data: unknown) => ({ type: 'event', event: { type, seq, time: 1000 + seq, data } });

describe('buildTranscript', () => {
  it('turns history records into user, assistant, tool and notice items', () => {
    const records = [
      ev(1, 'user/message', { content: [{ type: 'text', text: 'hello' }, { type: 'image', attachment: {} }] }),
      ev(2, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'Hi **there**' }] } }),
      ev(3, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
      ev(4, 'tool/result', { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } }),
      ev(5, 'request/header', { header: { secret: 'never-forwarded' } }),
      ev(6, 'turn/end', { reason: { kind: 'error', failure: { message: 'model down' } } }),
      ev(7, 'step/start', {}),
    ];
    const transcript = buildTranscript(records, { hasMore: false, running: true, title: 'T' });
    expect(transcript.running).toBe(true);
    expect(transcript.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'notice']);
    expect(transcript.items[0]).toMatchObject({ text: 'hello', images: 1 });
    expect(transcript.items[1]).toMatchObject({ text: 'Hi **there**', reasoning: 'think' });
    expect(transcript.items[2]).toMatchObject({ tool: { name: 'bash', output: 'a.txt' } });
    expect(JSON.stringify(transcript)).not.toContain('never-forwarded');
  });

  it('clips very long tool output and ignores malformed records', () => {
    const records = [null, 42, { event: 'x' }, ev(1, 'tool/call', { callId: 'c', name: 't', arguments: 'x' }), ev(2, 'tool/result', { message: { toolCallId: 'c', content: [{ type: 'text', text: 'y'.repeat(10_000) }] } })];
    const tool = buildTranscript(records, { hasMore: false, running: false, title: '' }).items[0];
    expect(tool?.kind).toBe('tool');
    if (tool?.kind === 'tool') expect((tool.tool.output ?? '').length).toBeLessThan(4_100);
  });

  it('validates session ids', () => {
    expect(isSessionId('session-a5a6b874-8642')).toBe(true);
    expect(isSessionId('../etc')).toBe(false);
    expect(isSessionId('')).toBe(false);
    expect(isSessionId(5)).toBe(false);
  });
});

describe('injected context messages', () => {
  it('shows only what a person typed, not runtime, time or skill context', () => {
    const ev = (seq: number, kind: string | undefined, text: string) => ({
      event: { type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }], ...(kind === undefined ? {} : { source: { kind } }) } },
    });
    const out = buildTranscript(
      [ev(1, 'user', 'real prompt'), ev(2, 'runtime-context', 'cwd...'), ev(3, 'time-context', 'Time sampled'), ev(4, 'skill-catalog', '<system-reminder>'), ev(5, undefined, 'legacy prompt')],
      { hasMore: false, running: false, title: '' },
    );
    expect(out.items.map((item) => (item.kind === 'user' ? item.text : ''))).toEqual(['real prompt', 'legacy prompt']);
  });
});
