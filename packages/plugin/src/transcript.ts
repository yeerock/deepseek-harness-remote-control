/**
 * Remote conversation transcript: reduces a Harness session's durable history
 * records to the plain items a peer's conversation view renders. Runs on the
 * computer that owns the session, so raw tool output and request headers never
 * cross the edge; long text is clipped.
 */

export interface TranscriptTool {
  callId: string;
  name: string;
  input: string;
  output?: string;
  failed?: boolean;
}

export type TranscriptItem =
  | { kind: 'user'; seq: number; time: number; text: string; images: number }
  | { kind: 'assistant'; seq: number; time: number; text: string; reasoning: string }
  | { kind: 'tool'; seq: number; time: number; tool: TranscriptTool }
  | { kind: 'notice'; seq: number; time: number; text: string; tone: 'info' | 'error' };

export interface Transcript {
  items: TranscriptItem[];
  hasMore: boolean;
  running: boolean;
  title: string;
}

const TEXT_MAX = 60_000;
const TOOL_INPUT_MAX = 1_200;
const TOOL_OUTPUT_MAX = 4_000;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${String(text.length - max)} more characters)`;
}

/** Concatenate the `text` parts of a content array of one type. */
function partsText(content: unknown, type: string): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part['type'] === type && typeof part['text'] === 'string') out.push(part['text']);
  }
  return out.join('\n\n');
}

function countImages(content: unknown): number {
  return Array.isArray(content) ? content.filter((part) => isRecord(part) && part['type'] === 'image').length : 0;
}

export function buildTranscript(records: unknown[], meta: { hasMore: boolean; running: boolean; title: string }): Transcript {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, TranscriptTool>();
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record['event'])) continue;
    const event = record['event'];
    const type = typeof event['type'] === 'string' ? event['type'] : '';
    const seq = typeof event['seq'] === 'number' ? event['seq'] : 0;
    const time = typeof event['time'] === 'number' ? event['time'] : 0;
    const data = isRecord(event['data']) ? event['data'] : {};
    switch (type) {
      case 'user/message': {
        const text = clip(partsText(data['content'], 'text'), TEXT_MAX);
        const images = countImages(data['content']);
        if (text.trim() !== '' || images > 0) items.push({ kind: 'user', seq, time, text, images });
        break;
      }
      case 'assistant/message': {
        const message = isRecord(data['message']) ? data['message'] : {};
        const text = clip(partsText(message['content'], 'text'), TEXT_MAX);
        const reasoning = clip(partsText(message['content'], 'reasoning'), TEXT_MAX);
        if (text.trim() !== '' || reasoning.trim() !== '') items.push({ kind: 'assistant', seq, time, text, reasoning });
        break;
      }
      case 'tool/call': {
        const callId = typeof data['callId'] === 'string' ? data['callId'] : `call-${String(seq)}`;
        const raw = typeof data['arguments'] === 'string' ? data['arguments'] : JSON.stringify(data['arguments'] ?? '');
        const tool: TranscriptTool = { callId, name: typeof data['name'] === 'string' ? data['name'] : 'tool', input: clip(raw, TOOL_INPUT_MAX) };
        tools.set(callId, tool);
        items.push({ kind: 'tool', seq, time, tool });
        break;
      }
      case 'tool/result': {
        const message = isRecord(data['message']) ? data['message'] : {};
        const callId = typeof message['toolCallId'] === 'string' ? message['toolCallId'] : '';
        const tool = tools.get(callId);
        if (tool !== undefined) {
          tool.output = clip(partsText(message['content'], 'text'), TOOL_OUTPUT_MAX);
          if (message['isError'] === true) tool.failed = true;
        }
        break;
      }
      case 'turn/end': {
        const reason = isRecord(data['reason']) ? data['reason'] : {};
        if (reason['kind'] === 'error' || reason['kind'] === 'failed') {
          const failure = isRecord(reason['failure']) && typeof reason['failure']['message'] === 'string' ? reason['failure']['message'] : 'The turn failed.';
          items.push({ kind: 'notice', seq, time, text: clip(failure, 600), tone: 'error' });
        } else if (reason['kind'] === 'cancelled' || reason['kind'] === 'interrupted') {
          items.push({ kind: 'notice', seq, time, text: 'Stopped.', tone: 'info' });
        }
        break;
      }
      case 'compaction/end':
        items.push({ kind: 'notice', seq, time, text: 'Earlier conversation was summarised to save context.', tone: 'info' });
        break;
      default:
        break;
    }
  }
  return { items, ...meta };
}
