/**
 * Remote Control client half (DSH RC project): a sidebar footer entry plus
 * a status modal.
 *
 * Bundle contract (verified against `@deepseek-ai/dsh-client-modules`): the
 * file is a classic script that calls `window.__ModuleLoader__.load({ id,
 * factory })`. The id must equal the package name; the factory gets a
 * `require` for shell-provided modules and returns `{ apply, inject }`.
 *
 * `inject` names the *client services* this plugin binds to. The host service
 * (`dsh-rc`) is reached over the authenticated connection RPC channel, so a
 * profile without the host half degrades to "host service unavailable"
 * instead of failing to mount.
 */

import { encodeQr, qrToSvg } from './qr.js';

interface RpcResult<T> {
  ok?: boolean;
  value?: T;
  error?: { code?: string; message?: string };
}

interface DshRcStatusView {
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

interface SharingInviteView {
  id?: string;
  label?: string;
  expiresAt?: number;
  maxUses?: number;
  uses?: number;
}

interface PendingApprovalView {
  id?: string;
  label?: string;
  ip?: string;
  createdAt?: number;
}

interface ActiveGuestView {
  sessionId?: string;
  label?: string;
  ip?: string;
  since?: number;
}

interface HarnessPeerView {
  id: string;
  name: string;
  platform?: string;
  online?: boolean;
  lastSeenAt?: number | null;
}

interface SharingView {
  enabled?: boolean;
  publicUrl?: string;
  invites?: SharingInviteView[];
  pendingApprovals?: PendingApprovalView[];
  activeGuests?: ActiveGuestView[];
}

interface CreatedInviteView {
  id?: string;
  url?: string;
  expiresAt?: number;
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
  uiWorkspace?: {
    startSession?: (workspaceId?: string, options?: Record<string, unknown>) => void;
  };
}

const LOCALE_NAMESPACE = 'dsh-rc';
const RPC_CHANNEL = '/dsh-rc';
const MODAL_ID = 'dsh-rc-status-modal';

/* ------------------------------ dictionaries ------------------------------ */

const EN: Record<string, string> = {
  title: 'Remote Control',
  subtitle: 'Remote control of this Harness',
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
  version: 'Version',
  update: 'Update',
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
  hostUnavailable: 'Host service unavailable. The Remote Control host plugin is not loaded in this profile, or its RPC channel failed to register.',
  hostUnavailableShort: 'Unavailable',
  disabledHint: 'The plugin is disabled in configuration. Press Start to run the agent anyway.',
  stoppedHint: 'The agent is not running.',
  qrHint: 'Scan to open the pairing link in a browser.',
  unconfigured: 'Set edgeUrl in the plugin config before starting.',
  sharingTitle: 'Share this Harness with guests',
  sharingOffHint: 'Off — nobody else can connect.',
  sharingOnHint: 'On — anyone with an invite link can request access. You approve every guest.',
  sharingOn: 'On',
  sharingOff: 'Off',
  sharingTtl: 'Invite expires',
  ttl15: '15 minutes',
  ttl60: '1 hour',
  ttl1440: '24 hours',
  ttlNever: 'Never',
  sharingCreate: 'Create invite',
  sharingCreating: 'Creating…',
  sharingInviteTitle: 'Invite link',
  sharingInviteOnce: 'Shown once. Anyone with this link can request access until it is used or expires.',
  sharingCopy: 'Copy',
  sharingCopied: 'Copied',
  sharingPending: 'Waiting for approval',
  sharingNoPending: 'No pending requests.',
  sharingApprove: 'Approve',
  sharingDeny: 'Deny',
  sharingGuests: 'Active guests',
  sharingNoGuests: 'No guests connected.',
  sharingRevoke: 'Revoke',
  sharingRevokeAll: 'Revoke all',
  sharingConfirmRevoke: 'Revoke this guest? Their browser session ends immediately.',
  sharingConfirmRevokeAll: 'Revoke all guests? Every guest session ends immediately.',
  sharingMultiWarning: 'Multiple guests share this one desktop — workspace, terminal and tools. They can interfere with each other.',
  sharingLoopbackWarning: 'Guests need a public edge URL. This edge advertises a loopback or unknown address, so an invite link will not open from another machine. Use Tailscale Funnel or a VPS edge.',
  sharingInvites: 'Outstanding invites',
  harnessTitle: 'Harnesses',
  remoteWorkspaces: 'Remote Workspaces',
  remoteWorkspacesEmpty: 'No other Harnesses paired yet.',
  remoteNewSession: 'New session at this Harness',
  harnessManage: 'Manage / approve',
  harnessHint: 'Pair another DeepSeek Harness as a host on this edge. Copy the setup prompt into that Harness; it registers automatically and no approval step is needed.',
  harnessPending: 'Waiting for the edge to finish registering this Harness…',
  sharingJoinTitle: 'Add another DeepSeek Harness',
  sharingJoinHint: 'The prompt installs DSH RC on that Harness, points its agent at this edge, and waits for your approval. It contains no password or secret.',
  sharingJoinButton: 'Build setup prompt',
  sharingJoinBuilding: 'Building…',
  sharingJoinCopy: 'Copy prompt',
  sharingJoinCopied: 'Copied',
  sharingJoinShown: 'Setup prompt (paste into the other Harness)',
  sharingJoinPublicUrl: 'Set a public edge URL (Tailscale Funnel or a VPS) before adding another computer.',
  sharingJoinUnavailable: 'Could not build the setup prompt.',
  sharingNoInvites: 'No outstanding invites.',
  sharingRevokeInvite: 'Revoke invite',
  sharingConfirmRevokeInvite: 'Revoke this invite link?',
  sharingErrorLabel: 'Sharing error',
  sharingGuestUnknown: 'Guest',
  sharingExpires: 'expires',
  sharingUses: 'uses',
};

const ZH: Record<string, string> = {
  title: '远程控制',
  subtitle: '远程控制此 Harness',
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
  version: '版本',
  update: '更新',
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
  hostUnavailable: '宿主服务不可用：此配置未加载 Remote Control 宿主插件，或其 RPC 通道注册失败。',
  hostUnavailableShort: '不可用',
  disabledHint: '插件在配置中处于禁用状态。点击“启动”仍可手动运行代理。',
  stoppedHint: '代理未运行。',
  qrHint: '扫码在浏览器中打开配对链接。',
  unconfigured: '请先在插件配置中设置 edgeUrl。',
  sharingTitle: '与访客共享此 Harness',
  sharingOffHint: '已关闭——其他人无法连接。',
  sharingOnHint: '已开启——任何持有邀请链接的人都可以申请访问。每位访客都需要你批准。',
  sharingOn: '开',
  sharingOff: '关',
  sharingTtl: '邀请有效期',
  ttl15: '15 分钟',
  ttl60: '1 小时',
  ttl1440: '24 小时',
  ttlNever: '永久',
  sharingCreate: '创建邀请',
  sharingCreating: '创建中…',
  sharingInviteTitle: '邀请链接',
  sharingInviteOnce: '仅显示一次。任何持有此链接的人在被使用或过期前均可申请访问。',
  sharingCopy: '复制',
  sharingCopied: '已复制',
  sharingPending: '等待批准',
  sharingNoPending: '没有待批准请求。',
  sharingApprove: '批准',
  sharingDeny: '拒绝',
  sharingGuests: '当前访客',
  sharingNoGuests: '暂无访客连接。',
  sharingRevoke: '撤销',
  sharingRevokeAll: '全部撤销',
  sharingConfirmRevoke: '撤销此访客？其浏览器会话将立即结束。',
  sharingConfirmRevokeAll: '撤销全部访客？所有访客会话都将立即结束。',
  sharingMultiWarning: '多位访客共享同一台桌面——工作区、终端和工具都可被操作，他们可能互相干扰。',
  sharingLoopbackWarning: '访客需要可公开访问的边缘地址。当前边缘节点广播的是回环或未知地址，因此邀请链接无法从其他机器打开。请使用 Tailscale Funnel 或 VPS 边缘节点。',
  sharingInvites: '未使用的邀请',
  harnessTitle: 'Harness 主机',
  remoteWorkspaces: '远程工作区',
  remoteWorkspacesEmpty: '尚未配对其他 Harness。',
  remoteNewSession: '在此 Harness 新建会话',
  harnessManage: '管理 / 批准',
  harnessHint: '把另一台 DeepSeek Harness 作为主机配对到此 edge。复制安装提示到那台 Harness；它会自动注册，无需批准。',
  harnessPending: '正在等待 edge 完成此 Harness 的注册…',
  sharingJoinTitle: '添加另一台 DeepSeek Harness',
  sharingJoinHint: '提示会在那台 Harness 上安装 DSH RC、把 agent 指向此 edge，并等待你的批准。提示中不含密码或密钥。',
  sharingJoinButton: '生成安装提示',
  sharingJoinBuilding: '生成中…',
  sharingJoinCopy: '复制提示',
  sharingJoinCopied: '已复制',
  sharingJoinShown: '安装提示（粘贴到另一台 Harness）',
  sharingJoinPublicUrl: '请先配置公开 edge 地址（Tailscale Funnel 或 VPS），再添加另一台电脑。',
  sharingJoinUnavailable: '无法生成安装提示。',
  sharingNoInvites: '没有未使用的邀请。',
  sharingRevokeInvite: '撤销邀请',
  sharingConfirmRevokeInvite: '撤销此邀请链接？',
  sharingErrorLabel: '共享错误',
  sharingGuestUnknown: '访客',
  sharingExpires: '到期',
  sharingUses: '已用',
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
    text.includes('unknown dsh-rc endpoint')
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


/** True when the edge's advertised URL cannot be reached from another machine. */
function isLoopbackPublicUrl(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0' ||
      host.endsWith('.localhost') ||
      host.startsWith('127.')
    );
  } catch {
    return true;
  }
}

/** Remaining time for an invite expiry; zero means "never" in the edge API. */
function formatExpiry(expiresAt: number | undefined, neverLabel: string): string {
  if (expiresAt === undefined || expiresAt === 0) return neverLabel;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return '0m';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

/* ------------------------------- styles ---------------------------------- */

/**
 * The Harness sidebar renders `sidebar.footer.action` inside a horizontal flex
 * row. With more than one plugin entry the rows squeeze into a single line.
 * Stack the footer when this plugin is present, and give the entry the same
 * metrics as a native panel row.
 */
function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('dsh-rc-sidebar-style') !== null) return;
  const style = document.createElement('style');
  style.id = 'dsh-rc-sidebar-style';
  style.textContent = `
div[class*="footerActions"]:has([data-dsh-rc-entry]) {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding: 0 2px;
}
[data-dsh-rc-entry] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  margin: 0;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
}
[data-dsh-rc-entry]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
[data-dsh-rc-entry]:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4c8dff);
  outline-offset: -2px;
}
[data-dsh-rc-entry] .dsh-rc-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-rc-entry] .dsh-rc-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #8a8f98);
}
[data-dsh-rc-entry] .dsh-rc-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex: 0 0 auto;
}
[data-dsh-rc-entry][data-collapsed="true"] {
  width: 36px;
  height: 36px;
  justify-content: center;
  padding: 0;
}
.dsh-rc-sidebar-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
}
.dsh-rc-sidebar-title {
  padding: 8px 8px 3px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary, #71717a);
}
.dsh-rc-sidebar-host {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  margin: 0;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dsh-rc-sidebar-host:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dsh-rc-sidebar-host:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4c8dff);
  outline-offset: -2px;
}
.dsh-rc-sidebar-host-dot { width: 6px; height: 6px; border-radius: 999px; flex: 0 0 auto; }
.dsh-rc-sidebar-host-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#dsh-rc-remote-workspaces {
  margin: 2px 0 2px;
  padding: 0;
}
.dsh-rc-remote-ws-header {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 0 0 4px;
  margin: 2px 0 2px;
}
.dsh-rc-remote-ws-title {
  font-size: 14px;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: normal;
  text-transform: none;
  color: var(--dsw-alias-label-secondary, #81858c);
}
.dsh-rc-remote-ws-empty {
  padding: 2px 8px 6px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #81858c);
}
.dsh-rc-remote-ws-row { display: flex; align-items: center; gap: 2px; }
.dsh-rc-remote-ws-open {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px;
  height: 28px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 13px; font-weight: 500;
  line-height: 20px; text-align: left; cursor: pointer;
}
.dsh-rc-remote-ws-open > svg { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #81858c); }
.dsh-rc-remote-ws-open:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dsh-rc-remote-ws-dot { width: 6px; height: 6px; border-radius: 999px; flex: 0 0 auto; margin-left: auto; }
.dsh-rc-remote-ws-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rc-remote-ws-new {
  flex: 0 0 auto; width: 24px; height: 24px; border: 0; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-secondary, #a1a1aa);
  font: 600 16px/1 inherit; cursor: pointer;
}
.dsh-rc-remote-ws-new:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, #fff); }
`;
  document.head.append(style);
}

function entryIcon(h: any): any {
  return h(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      style: { flex: '0 0 auto', display: 'block' },
    },
    h('rect', { x: 1.75, y: 2.75, width: 12.5, height: 8.5, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M5.25 14h5.5M8 11.5V14', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
  );
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
    divider: {
      marginTop: '18px',
      paddingTop: '14px',
      borderTop: '1px solid rgba(255,255,255,0.10)',
    } as const,
    sectionHeader: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
    } as const,
    sectionTitle: { fontSize: '13px', fontWeight: 600, color: '#f4f4f5' } as const,
    sectionHint: { marginTop: '6px', fontSize: '11.5px', color: '#a1a1aa' } as const,
    subheading: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      marginTop: '14px',
      marginBottom: '6px',
      fontSize: '12px',
      fontWeight: 600,
      color: '#e4e4e7',
    } as const,
    countBadge: {
      marginLeft: '6px',
      padding: '0 6px',
      borderRadius: '999px',
      background: 'rgba(255,255,255,0.10)',
      color: '#d4d4d8',
      fontSize: '10.5px',
      fontWeight: 500,
    } as const,
    switch: (enabled: boolean): Record<string, unknown> => ({
      position: 'relative',
      width: '36px',
      height: '20px',
      flex: '0 0 auto',
      padding: 0,
      border: '1px solid ' + (enabled ? '#2563eb' : 'rgba(255,255,255,0.20)'),
      borderRadius: '999px',
      background: enabled ? '#2563eb' : 'rgba(255,255,255,0.10)',
      cursor: 'pointer',
      transition: 'background 120ms ease',
    }),
    switchKnob: (enabled: boolean): Record<string, unknown> => ({
      position: 'absolute',
      top: '2px',
      left: enabled ? '18px' : '2px',
      width: '14px',
      height: '14px',
      borderRadius: '999px',
      background: '#f8fafc',
      transition: 'left 120ms ease',
    }),
    select: {
      boxSizing: 'border-box',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.14)',
      borderRadius: '8px',
      color: '#f4f4f5',
      padding: '5px 8px',
      fontSize: '12px',
    } as const,
    smallButton: {
      border: '1px solid rgba(255,255,255,0.16)',
      background: 'rgba(255,255,255,0.06)',
      color: '#f8fafc',
      borderRadius: '6px',
      padding: '3px 8px',
      fontSize: '11px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    } as const,
    dangerButton: {
      border: '1px solid rgba(239,68,68,0.55)',
      background: 'rgba(239,68,68,0.14)',
      color: '#fecaca',
      borderRadius: '6px',
      padding: '3px 8px',
      fontSize: '11px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    } as const,
    listRow: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '10px',
      padding: '6px 0',
      borderTop: '1px solid rgba(255,255,255,0.06)',
    } as const,
    listText: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } as const,
    listPrimary: { fontSize: '12px', color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
    listMeta: { fontSize: '10.5px', color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
    rowActions: { display: 'flex', gap: '6px', flex: '0 0 auto' } as const,
    inviteRow: {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      marginTop: '8px',
    } as const,
  };

  function DshRcAction(props: AnyProps): any {
    const t: (key: string) => string = props.t;
    const call: (endpoint: string, payload?: unknown) => Promise<any> = props.call;
    const ReactUse = React;
    const [status, setStatus] = ReactUse.useState(undefined as DshRcStatusView | undefined);
    const [harnessPeers, setHarnessPeers] = ReactUse.useState([] as HarnessPeerView[]);
    const [harnessPublicUrl, setHarnessPublicUrl] = ReactUse.useState('');
    const [open, setOpen] = ReactUse.useState(false);
    const [unavailable, setUnavailable] = ReactUse.useState(false);
    const [error, setError] = ReactUse.useState(undefined as string | undefined);
    const [busy, setBusy] = ReactUse.useState(false);
    const [copied, setCopied] = ReactUse.useState(false);
    const [sharing, setSharing] = ReactUse.useState(undefined as SharingView | undefined);
    const [sharingError, setSharingError] = ReactUse.useState(undefined as string | undefined);
    const [sharingBusy, setSharingBusy] = ReactUse.useState(false);
    const [joinPrompt, setJoinPrompt] = ReactUse.useState(undefined as string | undefined);
    const [joinCopied, setJoinCopied] = ReactUse.useState(false);
    const [joinError, setJoinError] = ReactUse.useState(undefined as string | undefined);
    const [ttlSeconds, setTtlSeconds] = ReactUse.useState(900);
    const [invite, setInvite] = ReactUse.useState(undefined as CreatedInviteView | undefined);
    const [inviteCopied, setInviteCopied] = ReactUse.useState(false);

    const refresh = ReactUse.useCallback(async () => {
      try {
        const next = (await call('status')) as DshRcStatusView;
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


    // Paired Harnesses for the sidebar switcher; metadata only, no secrets.
    ReactUse.useEffect(() => {
      let alive = true;
      const tick = async (): Promise<void> => {
        try {
          const result = (await call('harness.list')) as { peers?: HarnessPeerView[]; publicUrl?: string };
          if (!alive) return;
          setHarnessPeers(Array.isArray(result.peers) ? result.peers : []);
          if (typeof result.publicUrl === 'string') setHarnessPublicUrl(result.publicUrl);
        } catch {
          // The agent may still be connecting; keep the last known list.
        }
      };
      void tick();
      const timer = window.setInterval(() => void tick(), 5_000);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [call]);

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
        const next = (await call(endpoint)) as DshRcStatusView;
        setStatus(next);
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setBusy(false);
      }
    };


    /* ------------------------------ sharing ------------------------------ */

    const sharingEnabled = sharing?.enabled === true;

    const withSharingBusy = async (action: () => Promise<void>): Promise<void> => {
      setSharingBusy(true);
      setSharingError(undefined);
      try {
        await action();
      } catch (reason) {
        setSharingError(messageOf(reason));
      } finally {
        setSharingBusy(false);
      }
    };

    const refreshSharing = async (): Promise<void> => {
      const next = (await call('sharing.get')) as SharingView;
      setSharing(next);
    };

    const toggleSharing = (): void => {
      void withSharingBusy(async () => {
        await call('sharing.set', { enabled: !sharingEnabled });
        await refreshSharing();
        if (!sharingEnabled) setInvite(undefined);
      });
    };

    const createInvite = (): void => {
      void withSharingBusy(async () => {
        const created = (await call('sharing.invite', { ttlSeconds })) as CreatedInviteView;
        setInvite(created);
        setInviteCopied(false);
        await refreshSharing();
      });
    };

    const decideApproval = (id: string | undefined, decision: 'approve' | 'deny'): void => {
      if (id === undefined) return;
      void withSharingBusy(async () => {
        await call('sharing.decide', { id, decision });
        await refreshSharing();
      });
    };

    const revokeGuest = (sessionId: string | undefined): void => {
      if (sessionId === undefined) return;
      if (!window.confirm(t('sharingConfirmRevoke'))) return;
      void withSharingBusy(async () => {
        await call('sharing.revokeGuest', { sessionId });
        await refreshSharing();
      });
    };

    const revokeAllGuests = (): void => {
      if (!window.confirm(t('sharingConfirmRevokeAll'))) return;
      void withSharingBusy(async () => {
        await call('sharing.revokeAll');
        await refreshSharing();
      });
    };

    const revokeInvite = (id: string | undefined): void => {
      if (id === undefined) return;
      if (!window.confirm(t('sharingConfirmRevokeInvite'))) return;
      void withSharingBusy(async () => {
        await call('sharing.revokeInvite', { id });
        if (invite?.id === id) setInvite(undefined);
        await refreshSharing();
      });
    };

    const copyInviteUrl = async (): Promise<void> => {
      const url = invite?.url;
      if (url === undefined || url === '') return;
      try {
        if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(url);
        else {
          const area = document.createElement('textarea');
          area.value = url;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        }
        setInviteCopied(true);
        window.setTimeout(() => setInviteCopied(false), 1500);
      } catch (reason) {
        setSharingError(messageOf(reason));
      }
    };

    const dashboardUrl = (status?.edgeUrl ?? '').replace(/\/+$/, '');

    const openDashboard = (): void => {
      if (dashboardUrl === '') return;
      window.open(`${dashboardUrl}/`, '_blank', 'noopener,noreferrer');
    };

    const createJoinPrompt = (): void => {
      void withSharingBusy(async () => {
        setJoinError(undefined);
        const result = (await call('sharing.joinPrompt')) as { prompt?: string; reason?: string };
        if (typeof result.prompt === 'string' && result.prompt !== '') {
          setJoinPrompt(result.prompt);
          setJoinCopied(false);
        } else {
          setJoinError(result.reason === 'public-url-required' ? t('sharingJoinPublicUrl') : t('sharingJoinUnavailable'));
        }
      });
    };

    const copyJoinPrompt = async (): Promise<void> => {
      if (joinPrompt === undefined || joinPrompt === '') return;
      try {
        if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(joinPrompt);
        else {
          const area = document.createElement('textarea');
          area.value = joinPrompt;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        }
        setJoinCopied(true);
        window.setTimeout(() => setJoinCopied(false), 1500);
      } catch (reason) {
        setSharingError(messageOf(reason));
      }
    };

    const inviteQrSvg = ReactUse.useMemo(() => {
      const url = invite?.url;
      if (url === undefined || url === '') return undefined;
      const code = encodeQr(url);
      return code === undefined ? undefined : qrToSvg(code, 140);
    }, [invite?.url]);

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

    const redact = (value: string): string => value
      .replace(/\/Users\/[^/\s]+/g, '~')
      .replace(/\b[A-Za-z0-9._-]+\.local\b/gi, 'this-computer');
    const shortAgentPath = (value: string): string => {
      const marker = '/dsh-rc/';
      const at = value.indexOf(marker);
      return at >= 0 ? value.slice(at + marker.length) : redact(value);
    };

    const rows: any[] = [
      [t('version'), status?.version ?? '—', true],
      [t('state'), h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, h('span', { style: styles.dot(color) }), stateLabel)],
      [t('device'), redact(status?.deviceName ?? '—')],
      [t('edge'), redact(status?.edgeUrl ?? '—')],
    ];
    if (status?.deviceId !== undefined) rows.push([t('device') + ' ID', status.deviceId, true]);
    if (status?.latencyMs !== undefined) rows.push([t('latency'), `${String(status.latencyMs)} ms`]);
    rows.push([t('reconnects'), status?.reconnects ?? 0]);
    rows.push([t('restarts'), status?.restarts ?? 0]);
    rows.push([t('since'), formatSince(status?.since)]);
    if (status?.agentEntry !== undefined) rows.push([t('agentEntry'), shortAgentPath(status.agentEntry), true]);
    if (status?.latestVersion !== undefined && status.latestVersion !== status.version) {
      rows.push([t('update'), `${status.latestVersion} · ${status.updateState ?? ''}`]);
    }
    if (status?.pid !== undefined) rows.push([t('pid'), String(status.pid), true]);
    if (status?.lastError !== undefined) rows.push([t('lastError'), redact(status.lastError)]);

    const disabled = busy || unavailable;
    const pendingApprovals = Array.isArray(sharing?.pendingApprovals) ? sharing.pendingApprovals : [];
    const activeGuests = Array.isArray(sharing?.activeGuests) ? sharing.activeGuests : [];
    const sharingInvites = Array.isArray(sharing?.invites) ? sharing.invites : [];
    const sharingWarningStyle = (color: string): Record<string, unknown> => ({
      ...styles.banner(color),
      marginTop: '10px',
      marginBottom: 0,
    });

    const listRow = (key: string, primary: any, meta: any, actions: any[]): any =>
      h(
        'div',
        { style: styles.listRow, key },
        h(
          'div',
          { style: styles.listText },
          h('div', { style: styles.listPrimary }, primary),
          meta === undefined || meta === null ? null : h('div', { style: styles.listMeta }, meta),
        ),
        h('div', { style: styles.rowActions }, ...actions),
      );

    const sharingSection = h(
      'div',
      { style: styles.divider },
      h(
        'div',
        { style: styles.sectionHeader },
        h('div', { style: styles.sectionTitle }, t('sharingTitle')),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': sharingEnabled,
            'aria-label': t('sharingTitle'),
            title: sharingEnabled ? t('sharingOn') : t('sharingOff'),
            disabled: sharingBusy || unavailable,
            onClick: toggleSharing,
            style: styles.switch(sharingEnabled),
          },
          h('span', { style: styles.switchKnob(sharingEnabled) }),
        ),
      ),
      h('div', { style: styles.sectionHint }, sharingEnabled ? t('sharingOnHint') : t('sharingOffHint')),
      sharingError !== undefined
        ? h('div', { style: sharingWarningStyle('#f59e0b') }, `${t('sharingErrorLabel')}: ${sharingError}`)
        : null,
      sharingEnabled
        ? [
            isLoopbackPublicUrl(sharing?.publicUrl)
              ? h('div', { key: 'loopback', style: sharingWarningStyle('#f59e0b') }, t('sharingLoopbackWarning'))
              : null,
            h('div', { key: 'multi', style: sharingWarningStyle('#38bdf8') }, t('sharingMultiWarning')),
            h(
              'div',
              { key: 'invite-controls', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
              h('span', { style: styles.label }, t('sharingTtl')),
              h(
                'select',
                {
                  style: styles.select,
                  value: String(ttlSeconds),
                  disabled: sharingBusy,
                  onChange: (event: any) => setTtlSeconds(Number(event.target.value)),
                  'aria-label': t('sharingTtl'),
                },
                h('option', { value: '900' }, t('ttl15')),
                h('option', { value: '3600' }, t('ttl60')),
                h('option', { value: '86400' }, t('ttl1440')),
                h('option', { value: '0' }, t('ttlNever')),
              ),
              h('button', { type: 'button', style: styles.button(true), disabled: sharingBusy, onClick: createInvite }, sharingBusy ? t('sharingCreating') : t('sharingCreate')),
            ),
            invite?.url !== undefined && invite.url !== ''
              ? h(
                  'div',
                  { key: 'invite-result', style: { marginTop: '10px' } },
                  h('div', { style: styles.label }, t('sharingInviteTitle')),
                  h(
                    'div',
                    { style: styles.inviteRow },
                    h('input', {
                      style: styles.input,
                      readOnly: true,
                      spellCheck: false,
                      value: invite.url,
                      onFocus: (event: any) => event.target.select(),
                      onClick: (event: any) => event.target.select(),
                      'aria-label': t('sharingInviteTitle'),
                      'aria-readonly': 'true',
                    }),
                    h('button', { type: 'button', style: styles.smallButton, onClick: () => void copyInviteUrl() }, inviteCopied ? t('sharingCopied') : t('sharingCopy')),
                  ),
                  h('div', { style: styles.footerHint }, t('sharingInviteOnce')),
                  h('div', { style: styles.footerHint }, `${t('sharingExpires')}: ${formatExpiry(invite.expiresAt, t('ttlNever'))}`),
                  inviteQrSvg !== undefined
                    ? h(
                        'div',
                        { style: styles.qrBox },
                        h('div', { style: { width: '140px', height: '140px' }, dangerouslySetInnerHTML: { __html: inviteQrSvg } }),
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { key: 'pending-heading', style: styles.subheading },
              h('span', null, t('sharingPending'), h('span', { style: styles.countBadge }, pendingApprovals.length)),
            ),
            pendingApprovals.length === 0
              ? h('div', { key: 'no-pending', style: styles.footerHint }, t('sharingNoPending'))
              : pendingApprovals.map((approval: PendingApprovalView) =>
                  listRow(
                    `approval-${approval.id ?? approval.ip ?? 'unknown'}`,
                    approval.label !== undefined && approval.label !== '' ? approval.label : t('sharingGuestUnknown'),
                    `${approval.ip ?? '—'} · ${formatSince(approval.createdAt)}`,
                    [
                      h('button', { key: 'approve', type: 'button', style: styles.smallButton, disabled: sharingBusy, onClick: () => decideApproval(approval.id, 'approve') }, t('sharingApprove')),
                      h('button', { key: 'deny', type: 'button', style: styles.dangerButton, disabled: sharingBusy, onClick: () => decideApproval(approval.id, 'deny') }, t('sharingDeny')),
                    ],
                  ),
                ),
            h(
              'div',
              { key: 'guests-heading', style: styles.subheading },
              h('span', null, t('sharingGuests'), h('span', { style: styles.countBadge }, activeGuests.length)),
              activeGuests.length > 0
                ? h('button', { type: 'button', style: styles.dangerButton, disabled: sharingBusy, onClick: revokeAllGuests }, t('sharingRevokeAll'))
                : null,
            ),
            activeGuests.length === 0
              ? h('div', { key: 'no-guests', style: styles.footerHint }, t('sharingNoGuests'))
              : activeGuests.map((guest: ActiveGuestView) =>
                  listRow(
                    `guest-${guest.sessionId ?? guest.ip ?? 'unknown'}`,
                    guest.label !== undefined && guest.label !== '' ? guest.label : t('sharingGuestUnknown'),
                    `${guest.ip ?? '—'} · ${t('since')} ${formatSince(guest.since)}`,
                    [
                      h('button', { key: 'revoke', type: 'button', style: styles.dangerButton, disabled: sharingBusy, onClick: () => revokeGuest(guest.sessionId) }, t('sharingRevoke')),
                    ],
                  ),
                ),
            h(
              'div',
              { key: 'invites-heading', style: styles.subheading },
              h('span', null, t('sharingInvites'), h('span', { style: styles.countBadge }, sharingInvites.length)),
            ),
            sharingInvites.length === 0
              ? h('div', { key: 'no-invites', style: styles.footerHint }, t('sharingNoInvites'))
              : sharingInvites.map((row: SharingInviteView) =>
                  listRow(
                    `invite-${row.id ?? 'unknown'}`,
                    row.label !== undefined && row.label !== '' ? row.label : (row.id ?? '—'),
                    `${t('sharingExpires')}: ${formatExpiry(row.expiresAt, t('ttlNever'))} · ${String(row.uses ?? 0)}/${String(row.maxUses ?? 1)} ${t('sharingUses')}`,
                    [
                      h('button', { key: 'revoke-invite', type: 'button', style: styles.dangerButton, disabled: sharingBusy, onClick: () => revokeInvite(row.id) }, t('sharingRevokeInvite')),
                    ],
                  ),
                ),
          ]
        : null,
    );

    const harnessSection = h(
      'div',
      { style: styles.divider },
      h(
        'div',
        { style: styles.sectionHeader },
        h('div', { style: styles.sectionTitle }, t('harnessTitle')),
      ),
      h('div', { style: styles.sectionHint }, t('harnessHint')),
      h('div', { style: styles.subheading }, t('sharingJoinTitle')),
      h('div', { style: styles.footerHint }, t('sharingJoinHint')),
      h(
        'button',
        { type: 'button', style: styles.button(false), disabled: sharingBusy || unavailable, onClick: createJoinPrompt },
        sharingBusy ? t('sharingJoinBuilding') : t('sharingJoinButton'),
      ),
      joinError !== undefined ? h('div', { style: sharingWarningStyle('#f59e0b') }, joinError) : null,
      joinPrompt !== undefined
        ? h(
            'div',
            { style: { marginTop: '10px' } },
            h('div', { style: styles.label }, t('sharingJoinShown')),
            h('textarea', {
              style: { ...styles.input, width: '100%', minHeight: '120px', resize: 'vertical', fontFamily: 'inherit', fontSize: '11px', lineHeight: '16px' },
              readOnly: true,
              value: joinPrompt,
              'aria-label': t('sharingJoinShown'),
              onFocus: (event: any) => event.target.select(),
            }),
            h('button', { type: 'button', style: styles.smallButton, onClick: () => void copyJoinPrompt() }, joinCopied ? t('sharingJoinCopied') : t('sharingJoinCopy')),
          )
        : null,
    );

    const openHarness = (peer: HarnessPeerView, newSession = false): void => {
      const base = (harnessPublicUrl !== '' ? harnessPublicUrl : (status?.edgeUrl ?? '')).replace(/\/+$/, '');
      if (base === '') return;
      const suffix = newSession ? '?dsh-rc-new=1' : '';
      window.open(`${base}/d/${encodeURIComponent(peer.id)}/${suffix}`, '_blank', 'noopener,noreferrer');
    };

    // DSH's sidebar exposes `sidebar.workspaces` as a single slot occupied by
    // the native Workspaces section. Add a sibling inside the same region so
    // Remote Workspaces sits directly below it, and re-attach if React
    // reconciles the region.
    ReactUse.useEffect(() => {
      if (typeof document === 'undefined') return undefined;
      const slot = document.querySelector('[data-slot="sidebar.workspaces"]');
      const root = slot?.firstElementChild;
      const header = root?.querySelector('[class*="sectionHeader"]');
      if (root === null || root === undefined || header === null || header === undefined) return undefined;
      let container = document.getElementById('dsh-rc-remote-workspaces');
      if (container === null) {
        container = document.createElement('div');
        container.id = 'dsh-rc-remote-workspaces';
        container.className = 'dsh-rc-remote-ws';
      }
      // Directly below the native Workspaces header, before the local list.
      if (container.parentElement !== root || container.previousElementSibling !== header) {
        root.insertBefore(container, header.nextSibling);
      }
      const render = (): void => {
        if (container === null) return;
        container.replaceChildren();
        container.style.display = props.wide === false ? 'none' : '';
        if (props.wide === false) return;
        const header = document.createElement('div');
        header.className = 'dsh-rc-remote-ws-header';
        const title = document.createElement('span');
        title.className = 'dsh-rc-remote-ws-title';
        title.textContent = t('remoteWorkspaces');
        header.append(title);
        container.append(header);
        if (harnessPeers.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dsh-rc-remote-ws-empty';
          empty.textContent = t('remoteWorkspacesEmpty');
          container.append(empty);
          return;
        }
        for (const peer of harnessPeers) {
          const row = document.createElement('div');
          row.className = 'dsh-rc-remote-ws-row';
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'dsh-rc-remote-ws-open';
          open.title = peer.name;
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('viewBox', '0 0 24 24');
          icon.setAttribute('width', '16');
          icon.setAttribute('height', '16');
          icon.setAttribute('fill', 'none');
          icon.setAttribute('stroke', 'currentColor');
          icon.setAttribute('stroke-width', '1.6');
          icon.setAttribute('stroke-linecap', 'round');
          icon.setAttribute('stroke-linejoin', 'round');
          icon.setAttribute('aria-hidden', 'true');
          const screen = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          screen.setAttribute('x', '3'); screen.setAttribute('y', '4');
          screen.setAttribute('width', '18'); screen.setAttribute('height', '13');
          screen.setAttribute('rx', '2');
          const stand = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          stand.setAttribute('d', 'M8 21h8M12 17v4');
          icon.append(screen, stand);
          const dot = document.createElement('span');
          dot.className = 'dsh-rc-remote-ws-dot';
          dot.style.background = peer.online === true ? '#22c55e' : '#71717a';
          const name = document.createElement('span');
          name.className = 'dsh-rc-remote-ws-name';
          name.textContent = peer.name;
          open.append(icon, name, dot);
          open.addEventListener('click', () => openHarness(peer));
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'dsh-rc-remote-ws-new';
          add.textContent = '+';
          add.title = t('remoteNewSession');
          add.setAttribute('aria-label', `${t('remoteNewSession')}: ${peer.name}`);
          add.addEventListener('click', () => openHarness(peer, true));
          row.append(open, add);
          container.append(row);
        }
      };
      render();
      const observer = new MutationObserver(() => {
        if (container !== null && container.parentElement !== root) {
          root.insertBefore(container, header.nextSibling);
          render();
        }
      });
      observer.observe(root, { childList: true });
      return () => {
        observer.disconnect();
        container?.remove();
      };
    }, [harnessPeers, harnessPublicUrl, props.wide, status?.edgeUrl, t]);

    return h(
      'div',
      null,
      h(
        'button',
        {
          type: 'button',
          'data-dsh-rc-entry': 'true',
          'data-collapsed': props.wide === false ? 'true' : 'false',
          title: `${t('title')} — ${stateLabel}`,
          onClick: () => setOpen(true),
          'aria-haspopup': 'dialog',
          'aria-label': `${t('title')} — ${stateLabel}`,
        },
        entryIcon(h),
        props.wide === false
          ? null
          : h('span', { className: 'dsh-rc-label', key: 'label' }, t('title')),
        props.wide === false
          ? null
          : h(
              'span',
              { className: 'dsh-rc-status', key: 'status' },
              h('span', { className: 'dsh-rc-dot', style: { background: color } }),
              unavailable ? t('hostUnavailableShort') : (STATE_LABELS[state] !== undefined ? t(STATE_LABELS[state] as string) : ''),
            ),
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
              error !== undefined && !unavailable ? h('div', { style: styles.banner('#f59e0b') }, redact(error)) : null,
              (status?.updateState === 'installing' || status?.updateState === 'installed') && status.updateMessage !== undefined
                ? h('div', { style: styles.banner('#38bdf8') }, redact(status.updateMessage))
                : null,
              h(
                'div',
                { style: styles.grid },
                ...rows.flatMap(([label, value, mono]) => row(label as string, value, mono === true)),
              ),
              h(
                'div',
                { style: { ...styles.actions, marginTop: '10px' } },
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('start') }, t('start')),
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('restart') }, t('restart')),
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('stop') }, t('stop')),
              ),
              status?.state === 'stopped' && !unavailable ? h('div', { style: styles.footerHint }, t('stoppedHint')) : null,
              status?.enabled === false && !unavailable ? h('div', { style: styles.footerHint }, t('disabledHint')) : null,
              harnessSection,
            ),
          )
        : null,
    );
  }

  return DshRcAction;
}

/* --------------------------------- plugin --------------------------------- */

function apply(ctx: ClientContext): void {
  // The same client bundle is served to owners and guests. A guest must not
  // see (or attempt to call) the host sharing controls; the edge also blocks
  // /dsh-rc for guest sessions as defence in depth.
  if ((globalThis as unknown as Record<string, unknown>)['__DSH_RC_GUEST__'] === true) return;
  // `?dsh-rc-new=1` is set by the Remote Workspaces "+" action. It opens the
  // host UI and asks this host's workspace service to create a fresh session.
  if (typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('dsh-rc-new') === '1') {
        params.delete('dsh-rc-new');
        const query = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`);
        window.setTimeout(() => {
          try { ctx.uiWorkspace?.startSession?.(undefined, { clearPreviousDraft: false }); } catch { /* host UI decides */ }
        }, 700);
      }
    } catch { /* ignore malformed URLs */ }
  }
  const t = ctx.locale.bind(LOCALE_NAMESPACE);
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { en: EN, zh: ZH }), 'dsh-rc: dictionaries');

  const React = (globalThis as unknown as Record<string, any>)['__DSHRC_REACT__'];
  void React;

  // The component is created inside the factory so `require('react')` is the
  // module loader's shell instance.
  const component = createComponent(requireReact());
  const call = async (endpoint: string, payload?: unknown): Promise<any> => {
    const result = await ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload ?? {});
    if (result === undefined || result.ok !== true) {
      throw new Error(result?.error?.message ?? `dsh-rc ${endpoint} failed`);
    }
    return result.value;
  };

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'dsh-rc',
        order: 40,
        locale: LOCALE_NAMESPACE,
        inject: () => ({ call, t }),
      },
      component,
    ),
  );
  ensureStyles();
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
  if (loaderRequire === undefined) throw new Error(`dsh-rc: module loader require() is unavailable for ${id}`);
  return loaderRequire(id);
}

function loadModule(): void {
  const host = globalThis as unknown as { __ModuleLoader__?: { load?: (registration: unknown) => void } };
  const loader = host.__ModuleLoader__;
  if (loader === undefined || typeof loader.load !== 'function') {
    // Failing loudly inside the console is better than a silent no-op: the
    // boot audit will also report the missing bundle registration.
    console.warn('dsh-rc: window.__ModuleLoader__ is missing; client half not registered');
    return;
  }
  loader.load({
    id: '@dsh-rc/plugin',
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