import {
  confirmFullAccess,
  explainUnavailable,
  isFullAccess,
  modelEntries,
  openChoiceMenu,
  parseConfig,
  permissionEntries,
  renderModelTrigger,
  renderPermissionTrigger,
} from './session-settings.js';
import type { ModelSelection, SessionConfig } from './session-settings.js';

/**
 * Remote conversation panel.
 *
 * Registered in DSH's root `main` slot, so a remote session opens in the same
 * place a local conversation does (not in a browser or a sidebar tab). The
 * session itself keeps running on the computer that owns it; this view reads
 * its transcript and sends prompts through the host plugin, which relays them
 * over the edge to that computer's own Harness API.
 */

export interface RemoteTarget {
  deviceId: string;
  deviceName: string;
  sessionId: string;
  title: string;
  /** Shown once under the composer, e.g. a setting the new session could not take. */
  notice?: string;
}

type TranscriptItem =
  | { kind: 'user'; seq: number; text: string; images: number }
  | { kind: 'assistant'; seq: number; text: string; reasoning: string }
  | { kind: 'tool'; seq: number; tool: { callId: string; name: string; input: string; output?: string; failed?: boolean } }
  | { kind: 'notice'; seq: number; text: string; tone: 'info' | 'error' };

interface Transcript {
  items: TranscriptItem[];
  running: boolean;
  title: string;
  hasMore?: boolean;
  firstSeq?: number;
}

/** Earlier pages the reader asked for, kept while the newest page refreshes. */
interface Older {
  items: TranscriptItem[];
  firstSeq: number;
  hasMore: boolean;
}

/* --------------------------- shared selection --------------------------- */

let current: RemoteTarget | undefined;
const listeners = new Set<() => void>();

export const remoteChatStore = {
  get: (): RemoteTarget | undefined => current,
  set(target: RemoteTarget | undefined): void {
    current = target;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const REMOTE_PANEL_ID = 'dsh-rc.remote';

/* ------------------------------- markdown ------------------------------- */

const SAFE_LINK = /^https?:\/\//i;

/** Inline markdown to React nodes: code, bold, italic, links. Never HTML. */
function inline(h: any, text: string, keyBase: string): any[] {
  const out: any[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(!?\[[^\]]*\]\([^)\s]+\))/g;
  let last = 0;
  let index = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyBase}-${String(index++)}`;
    if (token.startsWith('`')) out.push(h('code', { key, className: 'dsh-rc-chat-code' }, token.slice(1, -1)));
    else if (token.startsWith('**')) out.push(h('strong', { key }, token.slice(2, -2)));
    else if (token.startsWith('![')) {
      // Remote images are not fetched; show their description instead.
      out.push(h('em', { key }, `[${token.slice(2, token.indexOf(']('))}]`));
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']('));
      const href = token.slice(token.indexOf('](') + 2, -1);
      out.push(SAFE_LINK.test(href) ? h('a', { key, href, target: '_blank', rel: 'noopener noreferrer' }, label) : label);
    } else out.push(h('em', { key }, token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Cells of one `| a | b |` table row; escaped pipes stay in the cell. */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Block markdown: fenced code, headings, lists, tables, paragraphs. */
function markdown(h: any, source: string, keyBase: string): any[] {
  const blocks: any[] = [];
  const parts = source.split(/^```[^\n]*\n?/m);
  parts.forEach((part, partIndex) => {
    const key = `${keyBase}-${String(partIndex)}`;
    if (partIndex % 2 === 1) {
      blocks.push(h('pre', { key, className: 'dsh-rc-chat-pre' }, part.replace(/\n$/, '')));
      return;
    }
    let list: { ordered: boolean; items: string[] } | undefined;
    let paragraph: string[] = [];
    let table: string[][] | undefined;
    const flushTable = (lineKey: string): void => {
      if (table === undefined) return;
      const [head = [], ...rows] = table;
      blocks.push(h('div', { key: `${lineKey}-tw`, className: 'dsh-rc-chat-table-wrap' }, h('table', { className: 'dsh-rc-chat-table' },
        h('thead', null, h('tr', null, ...head.map((cell, i) => h('th', { key: `h${String(i)}` }, ...inline(h, cell, `${lineKey}-th${String(i)}`))))),
        h('tbody', null, ...rows.map((row, r) => h('tr', { key: `r${String(r)}` }, ...head.map((_, i) => h('td', { key: `c${String(i)}` }, ...inline(h, row[i] ?? '', `${lineKey}-td${String(r)}-${String(i)}`)))))),
      )));
      table = undefined;
    };
    const flushParagraph = (lineKey: string): void => {
      if (paragraph.length === 0) return;
      blocks.push(h('p', { key: `${lineKey}-p` }, ...inline(h, paragraph.join(' '), `${lineKey}-p`)));
      paragraph = [];
    };
    const flushList = (lineKey: string): void => {
      if (list === undefined) return;
      const items = list.items.map((item, i) => h('li', { key: `${lineKey}-li${String(i)}` }, ...inline(h, item, `${lineKey}-li${String(i)}`)));
      blocks.push(h(list.ordered ? 'ol' : 'ul', { key: `${lineKey}-l` }, ...items));
      list = undefined;
    };
    const lines = part.split('\n');
    lines.forEach((line, lineIndex) => {
      const lineKey = `${key}-${String(lineIndex)}`;
      // A table: a pipe row followed by a --- rule row, then pipe rows.
      if (table !== undefined) {
        if (line.includes('|') && line.trim() !== '') {
          if (!TABLE_RULE.test(line)) table.push(tableCells(line));
          return;
        }
        flushTable(lineKey);
      } else if (line.includes('|') && TABLE_RULE.test(lines[lineIndex + 1] ?? '') && (lines[lineIndex + 1] ?? '').includes('|')) {
        flushParagraph(lineKey);
        flushList(lineKey);
        table = [tableCells(line)];
        return;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (heading !== null) {
        flushParagraph(lineKey);
        flushList(lineKey);
        blocks.push(h('div', { key: lineKey, className: 'dsh-rc-chat-h' }, ...inline(h, heading[2] ?? '', lineKey)));
      } else if (bullet !== null || numbered !== null) {
        flushParagraph(lineKey);
        const ordered = numbered !== null;
        if (list !== undefined && list.ordered !== ordered) flushList(lineKey);
        list ??= { ordered, items: [] };
        list.items.push((bullet ?? numbered)?.[1] ?? '');
      } else if (line.trim() === '') {
        flushParagraph(lineKey);
        flushList(lineKey);
      } else {
        flushList(lineKey);
        paragraph.push(line);
      }
    });
    flushParagraph(`${key}-end`);
    flushList(`${key}-end`);
    flushTable(`${key}-end`);
  });
  return blocks;
}

/* --------------------------------- styles -------------------------------- */

export const REMOTE_CHAT_CSS = `
.dsh-rc-chat { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary, inherit); }
.dsh-rc-chat-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 12px 20px; padding-top: max(12px, var(--dsh-frame-top-clearance, 0px)); border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2)); }
.dsh-rc-chat-badge { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 11px; font-size: 12px; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14)); color: var(--dsw-alias-label-secondary, #8a8f98); }
.dsh-rc-chat-badge-dot { width: 7px; height: 7px; border-radius: 50%; }
.dsh-rc-chat-title { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rc-chat-link { flex: 0 0 auto; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
.dsh-rc-chat-link:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, inherit); }
.dsh-rc-chat-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.dsh-rc-chat-col { max-width: var(--dsh-chat-content-width, 748px); margin: 0 auto; padding: 16px 16px 32px; display: flex; flex-direction: column; gap: 16px; }
.dsh-rc-chat-user { align-self: flex-end; max-width: min(calc(var(--dsh-chat-content-width, 748px) * .702), 82%); padding: 8px 14px; border-radius: var(--dsw-radius-xl, 16px); background: var(--dsw-specific-bubble, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, inherit); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }
.dsh-rc-chat-assistant { font-size: var(--dsh-content-font-size, 14px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: var(--dsw-alias-label-primary, inherit); overflow-wrap: anywhere; }
.dsh-rc-chat-assistant p { margin: 0 0 12px; }
.dsh-rc-chat-assistant ul, .dsh-rc-chat-assistant ol { margin: 0 0 10px; padding-left: 22px; }
.dsh-rc-chat-assistant a { color: var(--dsw-alias-label-link, #4c8bf5); }
.dsh-rc-chat-h { font-weight: 600; margin: 16px 0 8px; }
.dsh-rc-chat-code { font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.9em; padding: 1px 5px; border-radius: var(--dsw-radius-xs, 4px); background: var(--dsw-alias-markdown-code-inline, rgba(127,127,127,0.14)); }
.dsh-rc-chat-pre { margin: 0 0 12px; padding: 10px 12px; border: .5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25)); border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.08)); overflow-x: auto; overflow-y: hidden; font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12.5px; line-height: 1.55; white-space: pre; }
.dsh-rc-chat-think, .dsh-rc-chat-tool { font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-rc-chat-think summary, .dsh-rc-chat-tool summary { cursor: pointer; display: flex; align-items: center; gap: 6px; width: fit-content; max-width: 100%; padding: 0 4px 0 0; border-radius: var(--dsw-radius-sm, 6px); list-style: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-rc-chat-think summary:hover, .dsh-rc-chat-tool summary:hover { color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-rc-chat-think summary::before, .dsh-rc-chat-tool summary::before { content: ''; flex: none; width: 16px; height: 16px; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center / 14px no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center / 14px no-repeat; transition: transform .12s; }
.dsh-rc-chat-think[open] summary::before, .dsh-rc-chat-tool[open] summary::before { transform: rotate(90deg); }
.dsh-rc-chat-think summary::-webkit-details-marker, .dsh-rc-chat-tool summary::-webkit-details-marker { display: none; }
.dsh-rc-chat-think-body { white-space: pre-wrap; padding: 4px 0 4px 22px; margin: 0 0 8px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-rc-chat-tool .dsh-rc-chat-pre { box-sizing: border-box; width: calc(100% - 22px); max-height: 141px; overflow-y: auto; margin: 4px 0 8px 22px; border: 0; border-radius: var(--dsw-radius-md, 8px); font-size: 12px; }
.dsh-rc-chat-tool-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-rc-chat-tool-failed { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-rc-chat-notice { align-self: center; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-rc-chat-notice[data-tone="error"] { color: #ef4444; }
.dsh-rc-chat-empty { margin: 48px auto; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-rc-chat-table-wrap { margin: 0 0 10px; overflow-x: auto; overflow-y: hidden; }
.dsh-rc-chat-table { border-collapse: collapse; font-size: 13px; line-height: 1.5; }
.dsh-rc-chat-table th, .dsh-rc-chat-table td { padding: 6px 10px; border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25)); text-align: left; vertical-align: top; }
.dsh-rc-chat-table th { font-weight: 600; background: rgba(127,127,127,0.08); }
.dsh-rc-chat-foot { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; padding: 6px 20px 16px; }
.dsh-rc-chat-error, .dsh-rc-chat-settings-note { box-sizing: border-box; width: 100%; max-width: 792px; margin: 0 0 6px; }
.dsh-rc-chat-error { padding: 4px 8px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239,68,68,0.08)); color: var(--dsw-alias-state-error-primary, #dc2626); font-size: 12px; line-height: 18px; }
.dsh-rc-chat-card { box-sizing: border-box; width: 100%; max-width: 792px; display: flex; flex-direction: column; border-radius: var(--dsw-radius-panel, 20px); background: var(--dsw-specific-input-major, var(--dsw-alias-bg-primary, #fff)); box-shadow: var(--dsw-elevation-soft, 0 0 0 0.5px rgba(127,127,127,0.25), 0 2px 8px rgba(0,0,0,0.06)); }
.dsh-rc-chat-input { display: block; box-sizing: border-box; width: 100%; min-height: 48px; max-height: 200px; resize: none; border: 0; outline: none; background: transparent; color: inherit; font: inherit; font-size: var(--dsh-content-font-size, 14px); line-height: 24px; padding: 12px 16px 4px; }
.dsh-rc-chat-input::placeholder { color: var(--dsw-alias-label-tertiary, #9ca3af); }
.dsh-rc-chat-toolbar { display: flex; align-items: center; gap: 4px; min-width: 0; padding: 4px 8px 8px 10px; }
.dsh-rc-chat-send { flex: none; width: 32px; height: 32px; margin-left: 4px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 50%; cursor: pointer; background: var(--dsw-alias-state-business-primary, #4d6bfe); color: #fff; }
.dsh-rc-chat-send:hover:not([disabled]) { filter: brightness(1.06); }
.dsh-rc-chat-send[disabled] { background: var(--dsw-alias-state-business-disabled, #b8c4fb); cursor: default; }
.dsh-rc-chat-send[data-stop="true"] { background: var(--dsw-alias-label-primary, #1f2329); color: var(--dsw-alias-bg-primary, #fff); }
.dsh-rc-chat-connecting { margin: 72px auto; display: flex; flex-direction: column; align-items: center; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-rc-spinner { display: inline-block; flex: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25)); border-top-color: var(--dsw-alias-label-secondary, #6b7280); animation: dsh-rc-spin 0.8s linear infinite; }
.dsh-rc-spinner-lg { width: 22px; height: 22px; }
@keyframes dsh-rc-spin { to { transform: rotate(360deg); } }
.dsh-rc-chat-older {
  align-self: center; margin: 0 0 8px; padding: 4px 12px; border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25));
  border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); font: inherit; font-size: 12px; cursor: pointer;
}
.dsh-rc-chat-older:disabled { opacity: 0.6; cursor: default; }
.dsh-rc-chat-working { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
`;

/* -------------------------------- component ------------------------------ */

export interface RemoteChatDeps {
  call: (endpoint: string, payload?: unknown) => Promise<any>;
  t: (key: string) => string;
  openFullView: (target: RemoteTarget) => void;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function createRemoteChat(React: any): (props: Record<string, any>) => any {
  const h = React.createElement;

  return function RemoteChat(props: Record<string, any>): any {
    const { call, t, openFullView } = props as unknown as RemoteChatDeps;
    const [target, setTarget] = React.useState(remoteChatStore.get());
    const [transcript, setTranscript] = React.useState(undefined as Transcript | undefined);
    const [error, setError] = React.useState(undefined as string | undefined);
    const [draft, setDraft] = React.useState('');
    const [sending, setSending] = React.useState(false);
    const [tick, setTick] = React.useState(0);
    const bodyRef = React.useRef(null);
    const pinned = React.useRef(true);
    const [older, setOlder] = React.useState(undefined as Older | undefined);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    const keepOffset = React.useRef(undefined as number | undefined);
    // Model, effort and permission of the remote session, as the local composer shows them.
    const [config, setConfig] = React.useState(undefined as SessionConfig | undefined);
    const [model, setModel] = React.useState(null as ModelSelection | null);
    const [permission, setPermission] = React.useState(null as string | null);
    const [settingsBusy, setSettingsBusy] = React.useState(false);
    // A refresh that lands while a change is in flight must not undo it.
    const settingsWrite = React.useRef(0);
    const permissionRef = React.useRef(null);
    const modelRef = React.useRef(null);
    // Why the controls are missing (older host, or an error), shown instead of hiding them silently.
    const [configError, setConfigError] = React.useState(undefined as unknown);
    const noteRef = React.useRef(null);
    const noteGeneration = React.useRef(0);

    React.useEffect(() => remoteChatStore.subscribe(() => setTarget(remoteChatStore.get())), []);

    // Load the transcript; poll quickly while the remote agent is working.
    React.useEffect(() => {
      if (target === undefined) return undefined;
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const load = async (): Promise<void> => {
        let running = false;
        try {
          const next = (await call('session.history', { deviceId: target.deviceId, sessionId: target.sessionId })) as Transcript;
          if (!alive) return;
          setTranscript(next);
          setError(undefined);
          running = next.running;
        } catch (reason) {
          if (alive) setError(messageOf(reason));
        }
        if (alive) timer = setTimeout(() => void load(), running ? 1500 : 5000);
      };
      void load();
      return () => {
        alive = false;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [target?.deviceId, target?.sessionId, tick]);

    React.useEffect(() => {
      setTranscript(undefined);
      setConfig(undefined);
      setConfigError(undefined);
      setOlder(undefined);
      setDraft('');
      setError(target?.notice);
      pinned.current = true;
    }, [target?.deviceId, target?.sessionId]);

    // Read the session's settings when it opens and after each turn (the
    // owner may also change them on that computer). An older computer
    // answers with an error: the controls stay hidden.
    const settledRunning = transcript?.running === true;
    React.useEffect(() => {
      if (target === undefined) return undefined;
      let alive = true;
      const writeAtStart = settingsWrite.current;
      call('session.config', { deviceId: target.deviceId, sessionId: target.sessionId }).then(
        (value: unknown) => {
          if (!alive) return;
          const parsed = parseConfig(value);
          setConfig(parsed);
          if (parsed !== undefined) setConfigError(undefined);
          else setConfigError((previous: unknown) => previous ?? new Error('remote Harness answered HTTP 403'));
          if (settingsWrite.current !== writeAtStart) return;
          setModel(parsed?.session?.model ?? parsed?.models.default ?? null);
          setPermission(parsed?.session?.permission ?? null);
        },
        (reason: unknown) => {
          if (!alive) return;
          setConfig(undefined);
          // Keep the same error object when the message is unchanged, so the note is not rebuilt on every reload.
          setConfigError((previous: unknown) => (previous instanceof Error && reason instanceof Error && previous.message === reason.message ? previous : reason));
        },
      );
      return () => { alive = false; };
    }, [target?.deviceId, target?.sessionId, settledRunning]);

    React.useEffect(() => {
      const button = permissionRef.current as HTMLButtonElement | null;
      if (button !== null && config !== undefined) renderPermissionTrigger(button, t, config, permission);
      const chip = modelRef.current as HTMLButtonElement | null;
      if (chip !== null && config !== undefined) renderModelTrigger(chip, t, config, model);
    });

    React.useEffect(() => {
      const note = noteRef.current as HTMLElement | null;
      if (note === null || target === undefined || configError === undefined) return undefined;
      const generation = ++noteGeneration.current;
      void explainUnavailable(note, {
        isCurrent: () => noteGeneration.current === generation,
        t,
        deviceName: target.deviceName,
        reason: configError,
        status: () => call('session.status', { deviceId: target.deviceId }),
        update: () => call('session.update', { deviceId: target.deviceId }),
      });
      return () => { noteGeneration.current += 1; };
    }, [configError, target?.deviceId, target?.sessionId]);

    // Stay at the bottom while the reader is at the bottom; after loading an
    // earlier page, keep the message the reader was looking at in place.
    React.useEffect(() => {
      const body = bodyRef.current as HTMLElement | null;
      if (body === null) return;
      if (keepOffset.current !== undefined) {
        body.scrollTop = body.scrollHeight - keepOffset.current;
        keepOffset.current = undefined;
      } else if (pinned.current) body.scrollTop = body.scrollHeight;
    }, [transcript, older]);

    if (target === undefined) {
      return h('div', { className: 'dsh-rc-chat' }, h('div', { className: 'dsh-rc-chat-empty' }, t('chatPick')));
    }

    const running = transcript?.running === true;
    const applyModel = async (next: ModelSelection): Promise<void> => {
      const previous = model;
      settingsWrite.current += 1;
      setModel(next);
      setSettingsBusy(true);
      try {
        await call('session.selectModel', { deviceId: target.deviceId, sessionId: target.sessionId, selection: next });
      } catch (reason) {
        setModel(previous);
        setError(messageOf(reason));
      } finally {
        setSettingsBusy(false);
      }
    };
    const applyPermission = async (next: string): Promise<void> => {
      if (next === permission) return;
      // The same confirmation the local picker asks for before Full access.
      if (isFullAccess(next, config) && !isFullAccess(permission, config) && !(await confirmFullAccess(t))) return;
      const previous = permission;
      settingsWrite.current += 1;
      setPermission(next);
      setSettingsBusy(true);
      try {
        await call('session.setPermission', { deviceId: target.deviceId, sessionId: target.sessionId, permission: next });
      } catch (reason) {
        setPermission(previous);
        setError(messageOf(reason));
      } finally {
        setSettingsBusy(false);
      }
    };
    // The local composer's toolbar: Permissions on the left, model and effort on the right.
    const settingsNote = config === undefined && configError !== undefined
      ? h('div', { ref: noteRef, className: 'dsh-rc-modal-note dsh-rc-chat-settings-note', role: 'status' })
      : null;
    const permissionChip = config === undefined || config.permissions === null
      ? null
      : h('button', {
        type: 'button',
        ref: permissionRef,
        className: 'dsh-rc-set-trigger',
        disabled: settingsBusy,
        onClick: (event: any) => openChoiceMenu(event.currentTarget, t('settingsPermissions'), permissionEntries(t, config, permission, (value) => void applyPermission(value))),
      });
    const modelChip = config === undefined
      ? null
      : h('button', {
        type: 'button',
        ref: modelRef,
        className: 'dsh-rc-set-trigger',
        disabled: settingsBusy || config.models.groups.length === 0,
        onClick: (event: any) => openChoiceMenu(event.currentTarget, t('settingsModelAndEffort'), modelEntries(t, config, model, (value) => void applyModel(value))),
      });
    const send = async (): Promise<void> => {
      const text = draft.trim();
      if (text === '' || sending) return;
      setSending(true);
      setError(undefined);
      try {
        await call('session.prompt', { deviceId: target.deviceId, sessionId: target.sessionId, text });
        setDraft('');
        pinned.current = true;
        setTick((value: number) => value + 1);
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setSending(false);
      }
    };
    const stop = async (): Promise<void> => {
      try {
        await call('session.cancel', { deviceId: target.deviceId, sessionId: target.sessionId });
        setTick((value: number) => value + 1);
      } catch (reason) {
        setError(messageOf(reason));
      }
    };

    const latest: TranscriptItem[] = transcript?.items ?? [];
    const latestFirst = transcript?.firstSeq ?? (latest[0]?.seq ?? 0);
    const items: TranscriptItem[] = older === undefined
      ? latest
      : [...older.items.filter((item: TranscriptItem) => latestFirst === 0 || item.seq < latestFirst), ...latest];
    const canLoadOlder = older === undefined ? transcript?.hasMore === true : older.hasMore;
    const loadOlder = async (): Promise<void> => {
      const before = older?.firstSeq ?? latestFirst;
      if (loadingOlder || before <= 1) return;
      setLoadingOlder(true);
      const asked = `${target.deviceId}|${target.sessionId}`;
      try {
        const page = (await call('session.history', { deviceId: target.deviceId, sessionId: target.sessionId, beforeSeq: before })) as Transcript;
        // The reader may have opened another session while this page loaded.
        const now = remoteChatStore.get();
        if (now === undefined || `${now.deviceId}|${now.sessionId}` !== asked) return;
        const body = bodyRef.current as HTMLElement | null;
        if (body !== null) keepOffset.current = body.scrollHeight - body.scrollTop;
        setOlder((previous: Older | undefined) => ({
          items: [...page.items, ...(previous?.items ?? [])],
          firstSeq: page.firstSeq ?? page.items[0]?.seq ?? 0,
          hasMore: page.hasMore === true,
        }));
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setLoadingOlder(false);
      }
    };
    const rendered = items.map((item: TranscriptItem) => {
      const key = `${item.kind}-${String(item.seq)}`;
      if (item.kind === 'user') {
        return h('div', { key, className: 'dsh-rc-chat-user' }, item.text, item.images > 0 ? `\n[${String(item.images)} ${t('chatImages')}]` : '');
      }
      if (item.kind === 'assistant') {
        return h(
          'div',
          { key, className: 'dsh-rc-chat-assistant' },
          item.reasoning.trim() === ''
            ? null
            : h('details', { className: 'dsh-rc-chat-think' }, h('summary', null, t('chatThinking')), h('div', { className: 'dsh-rc-chat-think-body' }, item.reasoning)),
          ...markdown(h, item.text, key),
        );
      }
      if (item.kind === 'tool') {
        return h(
          'details',
          { key, className: 'dsh-rc-chat-tool' },
          h('summary', null, h('span', { className: 'dsh-rc-chat-tool-name' }, item.tool.name), item.tool.failed === true ? h('span', { className: 'dsh-rc-chat-tool-failed' }, t('chatFailed')) : null, item.tool.output === undefined ? h('span', { className: 'dsh-rc-spinner', role: 'img', 'aria-label': t('chatRunning') }) : null),
          h('pre', { className: 'dsh-rc-chat-pre' }, item.tool.input),
          item.tool.output === undefined ? null : h('pre', { className: 'dsh-rc-chat-pre' }, item.tool.output === '' ? t('chatNoOutput') : item.tool.output),
        );
      }
      return h('div', { key, className: 'dsh-rc-chat-notice', 'data-tone': item.tone }, item.text);
    });

    return h(
      'div',
      { className: 'dsh-rc-chat', 'data-dsh-rc-remote-chat': '' },
      h(
        'div',
        { className: 'dsh-rc-chat-head' },
        h('span', { className: 'dsh-rc-chat-badge', title: t('chatRemoteHint') }, h('span', { className: 'dsh-rc-chat-badge-dot', style: { background: '#22c55e' } }), target.deviceName),
        h('div', { className: 'dsh-rc-chat-title' }, transcript?.title || target.title || t('chatUntitled')),
        h('button', { type: 'button', className: 'dsh-rc-chat-link', onClick: () => openFullView(target), title: t('chatFullViewHint') }, t('chatFullView')),
      ),
      h(
        'div',
        {
          className: 'dsh-rc-chat-body',
          ref: bodyRef,
          onScroll: (event: any) => {
            const el = event.currentTarget as HTMLElement;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          },
        },
        h(
          'div',
          { className: 'dsh-rc-chat-col' },
          transcript === undefined && error === undefined
            ? h('div', { className: 'dsh-rc-chat-connecting', role: 'status' }, h('span', { className: 'dsh-rc-spinner dsh-rc-spinner-lg', 'aria-hidden': 'true' }), h('span', null, t('chatConnecting').replace('{name}', target.deviceName)))
            : null,
          canLoadOlder
            ? h('button', { type: 'button', className: 'dsh-rc-chat-older', disabled: loadingOlder, onClick: () => void loadOlder() }, loadingOlder ? t('chatLoading') : t('chatLoadEarlier'))
            : null,
          transcript !== undefined && items.length === 0 ? h('div', { className: 'dsh-rc-chat-empty' }, t('chatEmpty')) : null,
          ...rendered,
          running ? h('div', { className: 'dsh-rc-chat-working' }, t('chatWorking')) : null,
        ),
      ),
      h(
        'div',
        { className: 'dsh-rc-chat-foot' },
        error === undefined ? null : h('div', { className: 'dsh-rc-chat-error' }, error),
        settingsNote,
        h(
          'div',
          { className: 'dsh-rc-chat-card' },
          h('textarea', {
            className: 'dsh-rc-chat-input',
            rows: 1,
            value: draft,
            placeholder: t('chatPlaceholder').replace('{name}', target.deviceName),
            'aria-label': t('chatPlaceholder').replace('{name}', target.deviceName),
            onChange: (event: any) => {
              setDraft(event.target.value);
              const el = event.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = `${String(Math.min(200, el.scrollHeight))}px`;
            },
            onKeyDown: (event: any) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault();
                void send();
              }
            },
          }),
          h(
            'div',
            { className: 'dsh-rc-chat-toolbar' },
            permissionChip,
            h('span', { className: 'dsh-rc-set-spacer' }),
            modelChip,
            running && draft.trim() === ''
              ? h('button', { type: 'button', className: 'dsh-rc-chat-send', 'data-stop': 'true', title: t('chatStop'), 'aria-label': t('chatStop'), onClick: () => void stop() },
                h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('rect', { x: 1, y: 1, width: 10, height: 10, rx: 2, fill: 'currentColor' })))
              : h('button', { type: 'button', className: 'dsh-rc-chat-send', title: t('chatSend'), 'aria-label': t('chatSend'), disabled: sending || draft.trim() === '', onClick: () => void send() },
                h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
                  h('path', { d: 'M12 19V5' }), h('path', { d: 'm5 12 7-7 7 7' }))),
          ),
        ),
      ),
    );
  };
}
