/**
 * DSH Link client half: a sidebar footer entry plus a status modal.
 *
 * Bundle contract (verified against `@deepseek-ai/dsh-client-modules`): the
 * file is a classic script that calls `window.__ModuleLoader__.load({ id,
 * factory })`. The id must equal the package name; the factory gets a
 * `require` for shell-provided modules and returns `{ apply, inject }`.
 *
 * `inject` names the *client services* this plugin binds to. The host service
 * (`dsh-link`) is reached over the authenticated connection RPC channel, so a
 * profile without the host half degrades to "host service unavailable"
 * instead of failing to mount.
 */

import { encodeQr, qrToSvg } from './qr.js';

interface RpcResult<T> {
  ok?: boolean;
  value?: T;
  error?: { code?: string; message?: string };
}

interface DshLinkStatusView {
  state?: string;
  deviceName?: string;
  edgeUrl?: string;
  pairUrl?: string;
  deviceId?: string;
  latencyMs?: number;
  reconnects?: number;
  lastError?: string;
  since?: number;
  upstream?: string;
  agentRunning?: boolean;
  agentEntry?: string;
  pid?: number;
  restarts?: number;
}

interface ClientContext {
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>;
    };
  };
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): () => void;
  };
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown;
    bind(namespace: string): (key: string, values?: Record<string, unknown>) => string;
  };
  effect(dispose: () => void, label?: string): unknown;
}

const LOCALE_NAMESPACE = 'dsh-link';
const RPC_CHANNEL = '/dsh-link';
const MODAL_ID = 'dsh-link-status-modal';

/* ------------------------------ dictionaries ------------------------------ */

const EN: Record<string, string> = {
  title: 'DSH Link',
  subtitle: 'Remote access to this Harness',
  state: 'State',
  stateStarting: 'Starting',
  statePairing: 'Pairing',
  stateConnecting: 'Connecting',
  stateOnline: 'Online',
  stateReconnecting: 'Reconnecting',
  stateError: 'Error',
  stateStopped: 'Stopped',
  stateUnknown: 'Unknown',
  device: 'Device',
  edge: 'Edge',
  pairUrl: 'Pair URL',
  paired: 'Paired',
  pairedHint: 'This device is paired. To pair another browser, restart the agent to issue a new code.',
  noPairUrl: 'No pair URL yet. The agent prints one while pairing a device.',
  latency: 'Latency',
  reconnects: 'Reconnects',
  restarts: 'Restarts',
  since: 'Up time',
  lastError: 'Last error',
  none: 'None',
  agentEntry: 'Agent',
  pid: 'PID',
  copy: 'Copy',
  copied: 'Copied',
  open: 'Open',
  start: 'Start',
  restart: 'Restart',
  stop: 'Stop',
  close: 'Close',
  refresh: 'Refresh',
  hostUnavailable: 'Host service unavailable. The DSH Link host plugin is not loaded in this profile, or its RPC channel failed to register.',
  disabledHint: 'The plugin is disabled in configuration. Press Start to run the agent anyway.',
  stoppedHint: 'The agent is not running.',
  qrHint: 'Scan to open the pairing link in a browser.',
  unconfigured: 'Set edgeUrl in the plugin config before starting.',
};

const ZH: Record<string, string> = {
  title: 'DSH 远程访问',
  subtitle: '远程访问此 Harness',
  state: '状态',
  stateStarting: '启动中',
  statePairing: '等待配对',
  stateConnecting: '连接中',
  stateOnline: '在线',
  stateReconnecting: '重连中',
  stateError: '错误',
  stateStopped: '已停止',
  stateUnknown: '未知',
  device: '设备',
  edge: '边缘节点',
  pairUrl: '配对链接',
  paired: '已配对',
  pairedHint: '此设备已配对。若要配对另一个浏览器，请重启代理以获取新的配对码。',
  noPairUrl: '尚无配对链接。配对设备时由代理输出。',
  latency: '延迟',
  reconnects: '重连次数',
  restarts: '重启次数',
  since: '运行时长',
  lastError: '最近错误',
  none: '无',
  agentEntry: '代理入口',
  pid: '进程号',
  copy: '复制',
  copied: '已复制',
  open: '打开',
  start: '启动',
  restart: '重启',
  stop: '停止',
  close: '关闭',
  refresh: '刷新',
  hostUnavailable: '宿主服务不可用：此配置未加载 DSH Link 宿主插件，或其 RPC 通道注册失败。',
  disabledHint: '插件在配置中处于禁用状态。点击“启动”仍可手动运行代理。',
  stoppedHint: '代理未运行。',
  qrHint: '扫码在浏览器中打开配对链接。',
  unconfigured: '请先在插件配置中设置 edgeUrl。',
};

const STATE_LABELS: Record<string, string> = {
  starting: 'stateStarting',
  pairing: 'statePairing',
  connecting: 'stateConnecting',
  online: 'stateOnline',
  reconnecting: 'stateReconnecting',
  error: 'stateError',
  stopped: 'stateStopped',
};

const STATE_COLORS: Record<string, string> = {
  starting: '#94a3b8',
  pairing: '#f59e0b',
  connecting: '#38bdf8',
  online: '#22c55e',
  reconnecting: '#f59e0b',
  error: '#ef4444',
  stopped: '#64748b',
};

/* --------------------------------- helpers -------------------------------- */

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function isMissingChannel(reason: unknown): boolean {
  const text = messageOf(reason);
  return (
    text.includes('HTTP 404') ||
    text.includes('HTTP 405') ||
    text.includes(`transport failure for ${RPC_CHANNEL}/`) ||
    text.includes('unknown dsh-link endpoint')
  );
}

function formatSince(since: number | undefined): string {
  if (since === undefined || !Number.isFinite(since) || since <= 0) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

/* ------------------------------- component -------------------------------- */

type AnyProps = Record<string, any>;

function createComponent(React: any): (props: AnyProps) => any {
  const h = React.createElement;

  const styles = {
    footerButton: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      padding: '6px 10px',
      border: 'none',
      borderRadius: '8px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: '12px',
      lineHeight: '18px',
      textAlign: 'left',
      opacity: 0.9,
    } as const,
    dot: (color: string): Record<string, unknown> => ({
      width: '7px',
      height: '7px',
      borderRadius: '999px',
      background: color,
      flex: '0 0 auto',
      boxShadow: `0 0 0 2px ${color}33`,
    }),
    overlay: {
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)',
      padding: '16px',
    } as const,
    card: {
      width: '460px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100vh - 48px)',
      overflowY: 'auto',
      background: '#18181b',
      color: '#e4e4e7',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '12px',
      boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
      padding: '16px',
      font: '13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    } as const,
    header: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '12px',
      marginBottom: '12px',
    } as const,
    close: {
      border: 'none',
      background: 'transparent',
      color: '#a1a1aa',
      cursor: 'pointer',
      fontSize: '18px',
      lineHeight: '18px',
      padding: '2px 6px',
      borderRadius: '6px',
    } as const,
    banner: (color: string): Record<string, unknown> => ({
      padding: '8px 10px',
      borderRadius: '8px',
      background: `${color}1a`,
      border: `1px solid ${color}55`,
      color: '#f4f4f5',
      fontSize: '12px',
      marginBottom: '12px',
    }),
    grid: {
      display: 'grid',
      gridTemplateColumns: '104px 1fr',
      columnGap: '10px',
      rowGap: '7px',
      alignItems: 'baseline',
      fontSize: '12.5px',
    } as const,
    label: { color: '#a1a1aa' } as const,
    value: { color: '#f4f4f5', overflowWrap: 'anywhere' } as const,
    mono: {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '11.5px',
      color: '#f4f4f5',
      overflowWrap: 'anywhere',
    } as const,
    actions: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '8px',
      marginTop: '14px',
    } as const,
    button: (primary: boolean): Record<string, unknown> => ({
      border: primary ? '1px solid #2563eb' : '1px solid rgba(255,255,255,0.16)',
      background: primary ? '#2563eb' : 'rgba(255,255,255,0.06)',
      color: '#f8fafc',
      borderRadius: '8px',
      padding: '6px 12px',
      fontSize: '12px',
      cursor: 'pointer',
    }),
    input: {
      width: '100%',
      boxSizing: 'border-box',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.14)',
      borderRadius: '8px',
      color: '#f4f4f5',
      padding: '6px 8px',
      fontSize: '11.5px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    } as const,
    qrBox: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '120px',
      marginTop: '12px',
      borderRadius: '10px',
      background: '#ffffff',
      padding: '10px',
    } as const,
    qrPlaceholder: {
      color: '#3f3f46',
      fontSize: '11px',
      textAlign: 'center',
      padding: '12px',
    } as const,
    footerHint: { marginTop: '12px', fontSize: '11px', color: '#a1a1aa' } as const,
  };

  function DshLinkAction(props: AnyProps): any {
    const t: (key: string) => string = props.t;
    const call: (endpoint: string) => Promise<any> = props.call;
    const ReactUse = React;
    const [status, setStatus] = ReactUse.useState(undefined as DshLinkStatusView | undefined);
    const [open, setOpen] = ReactUse.useState(false);
    const [unavailable, setUnavailable] = ReactUse.useState(false);
    const [error, setError] = ReactUse.useState(undefined as string | undefined);
    const [busy, setBusy] = ReactUse.useState(false);
    const [copied, setCopied] = ReactUse.useState(false);

    const refresh = ReactUse.useCallback(async () => {
      try {
        const next = (await call('status')) as DshLinkStatusView;
        setStatus(next);
        setUnavailable(false);
        setError(undefined);
      } catch (reason) {
        if (isMissingChannel(reason)) {
          setUnavailable(true);
          setError(undefined);
        } else {
          setError(messageOf(reason));
        }
      }
    }, [call]);

    ReactUse.useEffect(() => {
      let alive = true;
      const tick = (): void => {
        if (alive) void refresh();
      };
      tick();
      const interval = window.setInterval(tick, open ? 1500 : 4000);
      return () => {
        alive = false;
        window.clearInterval(interval);
      };
    }, [refresh, open]);

    ReactUse.useEffect(() => {
      if (!open) return undefined;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setOpen(false);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    const run = async (endpoint: 'start' | 'restart' | 'stop'): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        const next = (await call(endpoint)) as DshLinkStatusView;
        setStatus(next);
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setBusy(false);
      }
    };

    const pairUrl = status?.pairUrl;
    const qrSvg = ReactUse.useMemo(() => {
      if (pairUrl === undefined || pairUrl === '') return undefined;
      const code = encodeQr(pairUrl);
      return code === undefined ? undefined : qrToSvg(code, 168);
    }, [pairUrl]);
    const state = unavailable ? 'error' : (status?.state ?? 'stopped');
    const color = STATE_COLORS[state] ?? STATE_COLORS['stopped'] ?? '#64748b';
    const stateLabel = unavailable ? t('hostUnavailable') : t(STATE_LABELS[state] ?? 'stateUnknown');
    // A pair code is single-use: after pairing it is dead. Only show the
    // URL/QR while the agent is actually waiting for an owner approval (or
    // while an error keeps a fresh code alive), never after "online".
    const showPairBlock = !unavailable && (state === 'pairing' || (state === 'error' && pairUrl !== undefined && pairUrl !== ''));
    const paired = !showPairBlock && status?.deviceId !== undefined && status?.deviceId !== '';

    const copyPairUrl = async (): Promise<void> => {
      if (pairUrl === undefined) return;
      try {
        if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(pairUrl);
        else {
          const area = document.createElement('textarea');
          area.value = pairUrl;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch (reason) {
        setError(messageOf(reason));
      }
    };

    const openPairUrl = (): void => {
      if (pairUrl === undefined) return;
      window.open(pairUrl, '_blank', 'noopener,noreferrer');
    };

    const row = (label: string, value: any, mono = false): [any, any] => [
      h('div', { style: styles.label, key: `l-${label}` }, label),
      h('div', { style: mono ? styles.mono : styles.value, key: `v-${label}` }, value),
    ];

    const rows: any[] = [
      [t('state'), h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span', { style: styles.dot(color) }), stateLabel)],
      [t('device'), status?.deviceName ?? '—'],
      [t('edge'), status?.edgeUrl ?? '—'],
    ];
    if (status?.deviceId !== undefined) rows.push([t('device') + ' ID', status.deviceId, true]);
    if (paired) rows.push([t('pairUrl'), t('paired')]);
    if (status?.latencyMs !== undefined) rows.push([t('latency'), `${String(status.latencyMs)} ms`]);
    rows.push([t('reconnects'), status?.reconnects ?? 0]);
    rows.push([t('restarts'), status?.restarts ?? 0]);
    rows.push([t('since'), formatSince(status?.since)]);
    if (status?.agentEntry !== undefined) rows.push([t('agentEntry'), status.agentEntry, true]);
    if (status?.pid !== undefined) rows.push([t('pid'), String(status.pid), true]);
    if (status?.lastError !== undefined) rows.push([t('lastError'), status.lastError]);

    const disabled = busy || unavailable;

    return h(
      'div',
      null,
      h(
        'button',
        {
          type: 'button',
          style: styles.footerButton,
          title: `${t('title')} — ${stateLabel}`,
          onClick: () => setOpen(true),
          'aria-haspopup': 'dialog',
        },
        h('span', { style: styles.dot(color) }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('title')),
        h('span', { style: { marginLeft: 'auto', color: '#a1a1aa', fontSize: '11px' } }, unavailable ? '!' : (STATE_LABELS[state] !== undefined ? t(STATE_LABELS[state] as string) : '')),
      ),
      open
        ? h(
            'div',
            {
              style: styles.overlay,
              role: 'presentation',
              onClick: (event: any) => {
                if (event.target === event.currentTarget) setOpen(false);
              },
            },
            h(
              'div',
              {
                id: MODAL_ID,
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('title'),
                style: styles.card,
              },
              h(
                'div',
                { style: styles.header },
                h(
                  'div',
                  null,
                  h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t('title')),
                  h('div', { style: { fontSize: '11.5px', color: '#a1a1aa' } }, t('subtitle')),
                ),
                h('button', { type: 'button', style: styles.close, onClick: () => setOpen(false), 'aria-label': t('close') }, '×'),
              ),
              unavailable ? h('div', { style: styles.banner('#ef4444') }, t('hostUnavailable')) : null,
              error !== undefined && !unavailable ? h('div', { style: styles.banner('#f59e0b') }, error) : null,
              h(
                'div',
                { style: styles.grid },
                ...rows.flatMap(([label, value, mono]) => row(label as string, value, mono === true)),
              ),
              showPairBlock
                ? h(
                    'div',
                    { style: { marginTop: '14px' } },
                    h('div', { style: styles.label }, t('pairUrl')),
                    h('input', {
                      style: { ...styles.input, marginTop: '6px' },
                      readOnly: true,
                      spellCheck: false,
                      value: pairUrl ?? '',
                      placeholder: t('noPairUrl'),
                      onFocus: (event: any) => event.target.select(),
                      onClick: (event: any) => event.target.select(),
                      'aria-label': t('pairUrl'),
                      'aria-readonly': 'true',
                    }),
                  )
                : null,
              showPairBlock && qrSvg !== undefined
                ? h(
                    'div',
                    { style: styles.qrBox, 'aria-label': t('qrHint') },
                    h('div', { style: { width: '168px', height: '168px' }, dangerouslySetInnerHTML: { __html: qrSvg } }),
                  )
                : null,
              showPairBlock && qrSvg !== undefined ? h('div', { style: styles.footerHint }, t('qrHint')) : null,
              paired ? h('div', { style: styles.footerHint }, t('pairedHint')) : null,
              h(
                'div',
                { style: { ...styles.actions, marginTop: '10px' } },
                showPairBlock
                  ? h('button', { type: 'button', style: styles.button(true), disabled: pairUrl === undefined, onClick: () => void copyPairUrl() }, copied ? t('copied') : t('copy'))
                  : null,
                showPairBlock
                  ? h('button', { type: 'button', style: styles.button(false), disabled: pairUrl === undefined, onClick: openPairUrl }, t('open'))
                  : null,
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('start') }, t('start')),
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('restart') }, t('restart')),
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('stop') }, t('stop')),
              ),
              status?.state === 'stopped' && !unavailable ? h('div', { style: styles.footerHint }, t('stoppedHint')) : null,
              status?.enabled === false && !unavailable ? h('div', { style: styles.footerHint }, t('disabledHint')) : null,
            ),
          )
        : null,
    );
  }

  return DshLinkAction;
}

/* --------------------------------- plugin --------------------------------- */

function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NAMESPACE);
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { en: EN, zh: ZH }), 'dsh-link: dictionaries');

  const React = (globalThis as unknown as Record<string, any>)['__DSH_LINK_REACT__'];
  void React;

  // The component is created inside the factory so `require('react')` is the
  // module loader's shell instance.
  const component = createComponent(requireReact());
  const call = async (endpoint: string): Promise<any> => {
    const result = await ctx.connection.rpc.call(RPC_CHANNEL, endpoint, {});
    if (result === undefined || result.ok !== true) {
      throw new Error(result?.error?.message ?? `dsh-link ${endpoint} failed`);
    }
    return result.value;
  };

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'dsh-link',
        order: 40,
        locale: LOCALE_NAMESPACE,
        inject: () => ({ call, t }),
      },
      component,
    ),
  );
  void t;
}

let cachedReact: any;

function requireReact(): any {
  if (cachedReact !== undefined) return cachedReact;
  // `require` is provided by the module loader to the factory; the function
  // below is replaced at registration time (see loadModule).
  cachedReact = requireFromLoader('react');
  return cachedReact;
}

let loaderRequire: ((id: string) => any) | undefined;

function requireFromLoader(id: string): any {
  if (loaderRequire === undefined) throw new Error(`dsh-link: module loader require() is unavailable for ${id}`);
  return loaderRequire(id);
}

function loadModule(): void {
  const host = globalThis as unknown as { __ModuleLoader__?: { load?: (registration: unknown) => void } };
  const loader = host.__ModuleLoader__;
  if (loader === undefined || typeof loader.load !== 'function') {
    // Failing loudly inside the console is better than a silent no-op: the
    // boot audit will also report the missing bundle registration.
    console.warn('dsh-link: window.__ModuleLoader__ is missing; client half not registered');
    return;
  }
  loader.load({
    id: '@dsh-link/plugin',
    factory: (requireModule: (id: string) => any) => {
      loaderRequire = requireModule;
      const module = { exports: {} as Record<string, unknown> };
      const exports = module.exports;
      exports.apply = apply;
      exports.inject = ['connection', 'slots', 'locale'];
      return module.exports;
    },
  });
}

loadModule();

export {};