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

import { PLUGIN_VERSION } from '../onboard.js';
import { encodeQr, qrToSvg } from './qr.js';
import { createRemoteChat, REMOTE_CHAT_CSS, REMOTE_PANEL_ID, remoteChatStore } from './remote-chat.js';
import type { RemoteTarget } from './remote-chat.js';
import { openNewSessionDialog, parseConfig, SESSION_SETTINGS_CSS, SETTINGS_LOCALE_EN, SETTINGS_LOCALE_ZH } from './session-settings.js';
import type { NewSessionChoice } from './session-settings.js';

// Which remote workspace groups are folded, kept across reloads (per viewer only).
const COLLAPSED_KEY = 'dsh-rc.remote.collapsed';
const collapsedRemoteGroups: Set<string> = (() => {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSED_KEY);
    const list: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string').slice(0, 500) : []);
  } catch {
    return new Set<string>();
  }
})();
const saveCollapsedRemoteGroups = (): void => {
  try { globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedRemoteGroups].slice(-500))); } catch { /* storage unavailable */ }
};

/* Remote session row actions, shaped like the local sidebar's hover strip. */
const ROW_ICONS: Record<string, string[]> = {
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5h4.1l2 2h8.9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z'],
  folderOpen: ['M3 17.5v-11A1.5 1.5 0 0 1 4.5 5h4.1l2 2h7.9A1.5 1.5 0 0 1 20 8.5V10', 'M3 17.5 5.6 11H21.5l-2.4 7a1.5 1.5 0 0 1-1.4 1H4.5A1.5 1.5 0 0 1 3 17.5Z'],
  chevron: ['m7 10 5 5 5-5'],
  plus: ['M12 6v12', 'M6 12h12'],
  pencil: ['M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  archive: ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4'],
  pin: ['M12 17v5', 'M9 10.8V5h6v5.8l2.4 3.2H6.6Z', 'M8 2h8'],
  unpin: ['M12 17v5', 'M9 10.8V5h6v5.8l2.4 3.2H6.6Z', 'M8 2h8', 'M3 3l18 18'],
};

function rowIcon(icon: string, size: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of [['viewBox', '0 0 24 24'], ['width', String(size)], ['height', String(size)], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', icon === 'more' ? '3' : '1.5'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) {
    svg.setAttribute(key as string, value as string);
  }
  for (const d of ROW_ICONS[icon] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * A copy of the icon DSH draws on its own local workspace rows, so remote rows
 * look identical; `undefined` when none is on screen (the caller falls back).
 * Only a static SVG is cloned, never markup with handlers.
 */
function nativeRowIcon(root: Element, icon: 'folder' | 'folderOpen' | 'chevron' | 'newSession', expanded: boolean): SVGSVGElement | undefined {
  const rows = Array.from(root.querySelectorAll('[data-row-key^="workspace:"]'));
  const row = icon === 'chevron' ? rows[0] : rows.find((candidate) => candidate.getAttribute('aria-expanded') === (expanded ? 'true' : 'false'));
  const seat = icon === 'newSession'
    ? rows[0]?.querySelector('button[aria-keyshortcuts]')
    : row?.children[icon === 'chevron' ? 1 : 0];
  const svg = seat?.querySelector(':scope > svg');
  if (!(svg instanceof SVGSVGElement)) return undefined;
  // Rebuild from shapes only, so nothing but geometry crosses over.
  const copy = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const name of ['viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width']) {
    const value = svg.getAttribute(name);
    if (value !== null) copy.setAttribute(name, value);
  }
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('data-native', '');
  const SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
  const KEEP = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity', 'transform', 'stroke-miterlimit'];
  for (const shape of Array.from(svg.querySelectorAll('*'))) {
    const tag = shape.localName;
    if (!SHAPES.has(tag)) continue;
    const clean = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const name of KEEP) {
      const value = shape.getAttribute(name);
      if (value !== null && !/url\(/i.test(value)) clean.setAttribute(name, value);
    }
    copy.append(clean);
  }
  return copy.childElementCount > 0 ? copy : undefined;
}

function rowIconButton(icon: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-rc-remote-ws-icon';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(rowIcon(icon, 16));
  return button;
}

interface RowMenuItem {
  label: string;
  run: () => void;
  separator?: boolean;
  /** Small icon before the label (an SVG built by this file, never markup). */
  icon?: SVGSVGElement;
  /** Hover text, e.g. a folder's full path. */
  hint?: string;
  /** A non-interactive caption above the items. */
  heading?: boolean;
}

/** A small menu under the "..." button; closes on choice, outside click, scroll or Escape. */
let closeRowMenu: (() => void) | undefined;

function openRowMenu(anchor: HTMLElement, entries: RowMenuItem[], onClose?: () => void): void {
  // A second press on the same "..." closes the menu it opened.
  const reopen = anchor.getAttribute('aria-expanded') !== 'true';
  closeRowMenu?.();
  if (!reopen) return;
  const menu = document.createElement('div');
  menu.id = 'dsh-rc-row-menu';
  menu.setAttribute('role', 'menu');
  const caption = entries.find((entry) => entry.heading === true)?.label;
  if (caption !== undefined) menu.setAttribute('aria-label', caption);
  const close = (): void => {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    onClose?.();
    if (closeRowMenu === close) closeRowMenu = undefined;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    document.removeEventListener('scroll', close, true);
  };
  const outside = (event: Event): void => {
    if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { close(); anchor.focus(); }
  };
  for (const entry of entries) {
    if (entry.heading === true) {
      const caption = document.createElement('div');
      caption.className = 'dsh-rc-row-menu-heading';
      caption.setAttribute('role', 'presentation');
      caption.textContent = entry.label;
      menu.append(caption);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.className = entry.separator === true ? 'dsh-rc-row-menu-item dsh-rc-row-menu-sep' : 'dsh-rc-row-menu-item';
    if (entry.hint !== undefined) button.title = entry.hint;
    if (entry.icon !== undefined) {
      button.classList.add('dsh-rc-row-menu-item-icon');
      const label = document.createElement('span');
      label.className = 'dsh-rc-row-menu-label';
      label.textContent = entry.label;
      button.append(entry.icon, label);
    } else {
      button.textContent = entry.label;
    }
    button.addEventListener('click', (event: MouseEvent) => { event.stopPropagation(); close(); entry.run(); });
    menu.append(button);
  }
  const rect = anchor.getBoundingClientRect();
  document.body.append(menu);
  // Open below the button, or above it when the menu would run off the bottom.
  const height = menu.offsetHeight;
  const below = rect.bottom + 4 + height <= window.innerHeight;
  const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = `${String(Math.round(Math.max(8, left) + window.scrollX))}px`;
  menu.style.top = `${String(Math.round((below ? rect.bottom + 4 : rect.top - 4 - height) + window.scrollY))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  closeRowMenu = close;
  (menu.querySelector('[role="menuitem"]') as HTMLElement | null)?.focus();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  document.addEventListener('scroll', close, true);
}


interface RpcResult<T> {
  ok?: boolean;
  value?: T;
  error?: { code?: string; message?: string };
}

interface DshRcStatusView {
  state?: string;
  hostEnabled?: boolean;
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

interface RemoteSessionView {
  id: string;
  title: string;
  updatedAt: number | null;
  workspaceId: string;
  workspaceName: string;
  pinned?: boolean;
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
  /** DSH's frame layout; `selectPanel` swaps the main area to a registered panel. */
  layout?: {
    selectPanel(id: string | null): void;
  };
  /** DSH's right-sidebar service; its `browser` tab is an in-app Electron webview. */
  sidebarRight?: {
    openTab(kind: string, options?: Record<string, unknown>): void;
    commandTarget?(element?: unknown): unknown;
    toggleFullscreen?(target: unknown): void;
  };
  uiWorkspace?: {
    openSession?: (target: unknown) => unknown;
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
  updates: 'Updates',
  updateUpToDate: 'Up to date',
  updateChecking: 'Checking',
  updateAvailable: '{v} found, installs when idle',
  updateInstalling: 'Installing {v}',
  updateReady: '{v} ready, restarts when idle',
  updateRestarting: 'Restarting for {v}',
  updateDevelopment: 'Development copy, updated with git',
  updateFailed: 'Update failed',
  updateNotChecked: 'Not checked yet',
  updateCheckedAgo: 'checked {age}',
  updateCheck: 'Check for Updates',
  pillUpdate: 'Update',
  pillRestart: 'Restart to Update',
  pillPreparing: 'Preparing to Restart…',
  pillRetry: 'Retry Update',
  pillAvailableDetail: 'DSH RC update: {v}',
  pillProgressDetail: 'Installing DSH RC update: {p}%\nTarget version: {v}',
  pillReadyDetail: 'DSH RC {v} is installed. Restart DeepSeek Harness to load it.',
  updateRestart: 'Restart to Update',
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
  remoteOfflineNote: '{name} is offline. Start DeepSeek Harness on that computer, then try again.',
  remoteNoWorkspace: 'Open that computer once so its workspaces are known, then try again.',
  remoteNewSessionIn: 'New Session in {name}',
  chatPick: 'Choose a remote session in the sidebar.',
  chatImages: 'image(s)',
  chatThinking: 'Thinking',
  chatRunning: 'running',
  chatNoOutput: '(no output)',
  chatRemoteHint: 'This session runs on that computer. Its files, tools and permissions stay there.',
  chatUntitled: 'New Session',
  chatFullView: 'Open Full View',
  chatFullViewHint: "Open that computer's own interface (files, terminal) in a side tab",
  chatLoading: 'Loading conversation…',
  chatLoadEarlier: 'Load Earlier Messages',
  chatEmpty: 'No messages yet. Send the first one below.',
  chatWorking: 'Working…',
  chatPlaceholder: 'Message {name}…',
  chatStop: 'Stop',
  chatSend: 'Send',
  renameHint: 'double-click to rename',
  rowArchive: 'Archive Session',
  rowPin: 'Pin Session',
  rowUnpin: 'Unpin Session',
  rowRename: 'Rename',
  rowCopyId: 'Copy Session ID',
  rowActionsFor: 'Session actions for {name}',
  renameComputer: 'Rename',
  shareTitle: 'Share This Computer',
  shareOn: 'Your other computers can open this one from Remote Workspaces. It appears there as "{name}".',
  shareOff: 'Off. This computer is disconnected and cannot be opened remotely. Your other computers are not affected.',
  shareStateOn: 'Shared',
  shareStateOff: 'Not Shared',
  remotePick: 'Select a Computer',
  remotePickHint: 'Choose a computer to see its sessions.',
  remoteRestartNeeded: 'The plugin was updated but is only half loaded. Quit DeepSeek Harness fully (including its tray or menu bar icon) and open it again to finish the update.',
  remoteNoneOnline: 'None of your other computers can be opened right now. They must be online, sharing, and on plugin v0.3.0 or later.',
  remoteRenameComputer: 'Rename Computer',
  remoteOffline: 'offline',
  remoteOpenComputer: 'Open Computer',
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
  remoteBadge: 'via edge',
  remoteBannerTitle: 'Remote Harness',
  remoteEmbedTitle: 'Remote session',
  remoteBannerHint: 'You are controlling another computer through DSH RC.',
  remoteWorkspacesEmpty: 'No other Harnesses paired yet.',
  remoteNewSession: 'New Session on This Computer',
  remoteChooseFolder: 'Choose a Project Folder',
  remoteSessionsLoading: 'Loading sessions…',
  remoteSessionsUnavailable: 'Sessions unavailable (update the plugin on that computer)',
  remoteSessionsEmpty: 'No sessions yet',
  remoteShowAll: 'Show all ({count})',
  remoteShowLess: 'Show less',
  harnessManage: 'Manage / approve',
  harnessHint: 'Pair another DeepSeek Harness as a host on this edge. Copy the setup prompt into that Harness; it registers automatically and no approval step is needed.',
  harnessPending: 'Waiting for the edge to finish registering this Harness…',
  sharingJoinTitle: 'Add Another DeepSeek Harness',
  sharingJoinHint: 'Paste it into the other Harness. It installs everything, connects to this edge and restarts that Harness by itself; no approval is needed. It contains no password or secret.',
  sharingJoinButton: 'Build Setup Prompt',
  sharingJoinBuilding: 'Building…',
  sharingJoinCopy: 'Copy prompt',
  sharingJoinCopied: 'Copied',
  sharingJoinShown: 'Setup Prompt (Paste into the Other Harness)',
  sharingJoinPublicUrl: 'Set a public edge URL (Tailscale Funnel or a VPS) before adding another computer.',
  sharingJoinUnavailable: 'Could not build the setup prompt.',
  sharingNoInvites: 'No outstanding invites.',
  sharingRevokeInvite: 'Revoke invite',
  sharingConfirmRevokeInvite: 'Revoke this invite link?',
  sharingErrorLabel: 'Sharing error',
  sharingGuestUnknown: 'Guest',
  sharingExpires: 'expires',
  sharingUses: 'uses',
  ...SETTINGS_LOCALE_EN,
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
  updates: '自动更新',
  updateUpToDate: '已是最新',
  updateChecking: '正在检查',
  updateAvailable: '发现 {v}，空闲时安装',
  updateInstalling: '正在安装 {v}',
  updateReady: '{v} 已就绪，空闲时自动重启',
  updateRestarting: '正在重启以加载 {v}',
  updateDevelopment: '开发副本，通过 git 更新',
  updateFailed: '更新失败',
  updateNotChecked: '尚未检查',
  updateCheckedAgo: '{age}前检查',
  updateCheck: '检查更新',
  pillUpdate: '更新',
  pillRestart: '重启以更新',
  pillPreparing: '正在准备重启…',
  pillRetry: '重试更新',
  pillAvailableDetail: 'DSH RC 更新：{v}',
  pillProgressDetail: '正在安装 DSH RC 更新：{p}%\n目标版本：{v}',
  pillReadyDetail: 'DSH RC {v} 已安装，重启 DeepSeek Harness 以加载。',
  updateRestart: '重启以更新',
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
  remoteOfflineNote: '{name} 已离线。请先在那台电脑上启动 DeepSeek Harness 再试。',
  remoteNoWorkspace: '请先打开那台电脑一次以读取其工作区，然后再试。',
  remoteNewSessionIn: '在 {name} 中新建会话',
  chatPick: '请在侧边栏选择一个远程会话。',
  chatImages: '张图片',
  chatThinking: '思考过程',
  chatRunning: '运行中',
  chatNoOutput: '（无输出）',
  chatRemoteHint: '此会话运行在那台电脑上，其文件、工具和权限都保留在那里。',
  chatUntitled: '新会话',
  chatFullView: '打开完整视图',
  chatFullViewHint: '在侧边标签中打开那台电脑自身的界面（文件、终端）',
  chatLoading: '正在加载对话…',
  chatLoadEarlier: '加载更早的消息',
  chatEmpty: '暂无消息，在下方发送第一条。',
  chatWorking: '处理中…',
  chatPlaceholder: '发送消息给 {name}…',
  chatStop: '停止',
  chatSend: '发送',
  renameHint: '双击可重命名',
  rowArchive: '归档会话',
  rowPin: '置顶会话',
  rowUnpin: '取消置顶',
  rowRename: '重命名',
  rowCopyId: '复制会话 ID',
  rowActionsFor: '{name} 的会话操作',
  renameComputer: '重命名',
  shareTitle: '共享这台电脑',
  shareOn: '你的其他电脑可在“远程工作区”中打开这台电脑，显示名称为“{name}”。',
  shareOff: '已关闭。这台电脑已断开，无法被远程打开，不影响你的其他电脑。',
  shareStateOn: '已共享',
  shareStateOff: '未共享',
  remotePick: '选择一台电脑',
  remotePickHint: '选择一台电脑以查看其会话。',
  remoteRestartNeeded: '插件已更新但尚未完全加载。请完全退出 DeepSeek Harness（包括托盘或菜单栏图标）后重新打开，以完成更新。',
  remoteNoneOnline: '目前没有可远程打开的电脑。对方需在线、已开启共享并使用 v0.3.0 或更高版本的插件。',
  remoteRenameComputer: '重命名电脑',
  remoteOffline: '离线',
  remoteOpenComputer: '打开这台电脑',
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
  remoteBadge: '经 edge',
  remoteBannerTitle: '远程 Harness',
  remoteEmbedTitle: '远程会话',
  remoteBannerHint: '你正在通过 DSH RC 控制另一台电脑。',
  remoteWorkspacesEmpty: '尚未配对其他 Harness。',
  remoteNewSession: '在此 Harness 新建会话',
  remoteChooseFolder: '选择项目文件夹',
  remoteSessionsLoading: '正在加载会话…',
  remoteSessionsUnavailable: '无法读取会话（请更新对方电脑上的插件）',
  remoteSessionsEmpty: '暂无会话',
  remoteShowAll: '显示全部（{count}）',
  remoteShowLess: '收起',
  harnessManage: '管理 / 批准',
  harnessHint: '把另一台 DeepSeek Harness 作为主机配对到此 edge。复制安装提示到那台 Harness；它会自动注册，无需批准。',
  harnessPending: '正在等待 edge 完成此 Harness 的注册…',
  sharingJoinTitle: '添加另一台 DeepSeek Harness',
  sharingJoinHint: '把提示粘贴到另一台 Harness。它会自动安装所需的一切、连接到此 edge 并自行重启那台 Harness，无需批准。提示中不含密码或密钥。',
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
  ...SETTINGS_LOCALE_ZH,
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

/** True while an inline rename box is open; the sidebar must not rebuild under it. */
let inlineEditing = false;

/**
 * Replace `target`'s content with a text box. Enter or leaving the box saves,
 * Escape cancels. `commit` may throw; `done` always runs afterwards so the
 * caller can rebuild the list.
 */
function editInline(
  target: HTMLElement,
  current: string,
  maxLength: number,
  commit: (value: string) => Promise<void>,
  done: (error?: string) => void,
): void {
  if (inlineEditing) return;
  inlineEditing = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.maxLength = maxLength;
  input.className = 'dsh-rc-inline-input';
  input.setAttribute('aria-label', current);
  let finished = false;
  const finish = (save: boolean): void => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    void (async () => {
      let failure: string | undefined;
      try {
        if (save && next !== '' && next !== current) await commit(next);
      } catch (reason) {
        failure = messageOf(reason);
      }
      inlineEditing = false;
      done(failure);
    })();
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  for (const type of ['click', 'dblclick', 'mousedown']) input.addEventListener(type, (event) => event.stopPropagation());
  target.replaceChildren(input);
  input.focus();
  input.select();
}

/** Single click runs `onClick` (after a short wait); double click runs `onDouble` instead. */
function clickOrDouble(element: HTMLElement, onClick: () => void, onDouble: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  element.addEventListener('click', () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onClick, 260);
  });
  element.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (timer !== undefined) clearTimeout(timer);
    onDouble();
  });
}

const PILL_DOWNLOAD = ['M8 1.95317V10.0469', 'M4.25 6.29688L8 10.0469L11.75 6.29688', 'M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469'];
const PILL_LOADING = ['M12.596 12.596C11.687 13.5049 10.5288 14.1239 9.26798 14.3747C8.00716 14.6255 6.70028 14.4968 5.51261 14.0048C4.32494 13.5129 3.30981 12.6798 2.59557 11.611C1.88134 10.5421 1.50008 9.2855 1.5 7.99998C1.50008 6.71446 1.88134 5.45783 2.59557 4.38898C3.30981 3.32013 4.32494 2.48707 5.51261 1.99513C6.70028 1.50319 8.00716 1.37447 9.26798 1.62524C10.5288 1.87602 11.687 2.49502 12.596 3.40398'];

/**
 * DSH RC's update status as DeepSeek Harness's own sidebar Update pill
 * (DesktopUpdateIndicator: same geometry, brand-blue tint, icons and phases).
 * Hidden when up to date, checking quietly, or a development copy.
 */
function updatePill(status: any, t: (key: string) => string, act: (endpoint: 'update.check' | 'update.restart') => void): HTMLElement | null {
  const phase = String(status?.updateState ?? 'idle');
  const v = String(status?.latestVersion ?? '');
  const raw = Number(status?.updatePercent ?? 0);
  const p = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
  const fill = (key: string): string => t(key).replace('{v}', v).replace('{p}', String(p));
  let label: string; let detail: string; let icon: 'download' | 'busy' | 'error'; let endpoint: 'update.check' | 'update.restart' | null;
  switch (phase) {
    case 'available': label = t('pillUpdate'); detail = fill('pillAvailableDetail'); icon = 'download'; endpoint = 'update.check'; break;
    case 'installing': label = `${String(p)}%`; detail = fill('pillProgressDetail'); icon = 'busy'; endpoint = null; break;
    case 'ready': label = t('pillRestart'); detail = fill('pillReadyDetail'); icon = 'download'; endpoint = 'update.restart'; break;
    case 'restarting': label = t('pillPreparing'); detail = v === '' ? label : `DSH RC ${v}`; icon = 'busy'; endpoint = null; break;
    case 'error': label = t('pillRetry'); detail = String(status?.updateMessage ?? label); icon = 'error'; endpoint = 'update.check'; break;
    default: return null;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-rc-update-pill';
  button.title = detail;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-live', 'polite');
  if (endpoint === null) button.setAttribute('aria-disabled', 'true');
  const iconSeat = document.createElement('span');
  iconSeat.className = 'dsh-rc-update-pill-icon';
  iconSeat.setAttribute('aria-hidden', 'true');
  if (icon === 'error') {
    const dot = document.createElement('span');
    dot.className = 'dsh-rc-update-pill-dot';
    iconSeat.append(dot);
  } else {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const attrs: Array<[string, string]> = [['width', '14'], ['height', '14'], ['viewBox', '0 0 16 16'], ['fill', 'none'], ['stroke-width', '1']];
    for (const [k, val] of attrs) svg.setAttribute(k, val);
    if (icon === 'busy') svg.setAttribute('class', 'dsh-rc-update-pill-spin');
    for (const d of icon === 'busy' ? PILL_LOADING : PILL_DOWNLOAD) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', 'currentColor');
      svg.append(path);
    }
    iconSeat.append(svg);
  }
  const text = document.createElement('span');
  text.textContent = label;
  button.append(iconSeat, text);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    // One request at a time: a second Restart to Update must never be sent.
    if (endpoint === null || button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    act(endpoint);
  });
  return button;
}

function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  // Same units as DSH's local session list: now, 34min, 5h, 1d.
  if (minutes < 60) return `${String(minutes)}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
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
  style.textContent = REMOTE_CHAT_CSS + SESSION_SETTINGS_CSS + `
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
#dsh-rc-remote-banner {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483000;
  padding: 7px 14px;
  border: 1px solid var(--dsw-alias-border-subtle, #2b3344);
  border-radius: 999px;
  background: #131a2e;
  color: #e6ecff;
  font: 500 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 6px 24px #0008;
  text-align: center;
  pointer-events: none;
}
.dsh-rc-remote-banner-title { font-weight: 600; }
.dsh-rc-remote-banner-hint { margin-top: 1px; font-size: 10.5px; color: #a5b4d4; }
#dsh-rc-remote-workspaces {
  margin: 16px 0 24px;
}
.dsh-rc-remote-ws-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 36px;
  padding: 0 0 0 4px;
  margin: 2px -4px 4px 0;
  border-radius: var(--dsw-radius-md, 12px);
}
.dsh-rc-remote-ws-gear {
  position: relative;
  flex: 0 0 auto;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  box-shadow: none;
  color: var(--dsw-alias-label-secondary, #81858c);
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
}
.dsh-rc-remote-ws-gear:hover { background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-primary, #d4d4d8); }
.dsh-rc-remote-ws-gear:focus { outline: none; box-shadow: none; }
.dsh-rc-remote-ws-gear:focus-visible { outline: 1.5px solid var(--dsw-focus-ring-color, #4c8dff); outline-offset: 1px; }
.dsh-rc-update-pill {
  --dsh-rc-brand: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4d6bfe);
  box-sizing: border-box; flex: none; display: inline-grid; grid-template-columns: 14px max-content; align-items: center; column-gap: 4px;
  height: 28px; padding: 0 8px; border: 1px solid color-mix(in srgb, var(--dsh-rc-brand) 20%, transparent); border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsh-rc-brand) 8%, transparent); color: var(--dsh-rc-brand);
  font-family: inherit; font-size: 12px; font-weight: 500; line-height: 18px; text-align: left; white-space: nowrap; cursor: pointer;
}
.dsh-rc-update-pill[aria-disabled=true] { cursor: default; }
.dsh-rc-update-pill:focus { outline: none; }
.dsh-rc-update-pill:focus-visible { outline: 1.5px solid var(--dsw-focus-ring-color, #4c8dff); outline-offset: 1px; }
.dsh-rc-update-pill-icon { display: grid; place-items: center; width: 14px; height: 14px; }
.dsh-rc-update-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dsh-rc-update-pill-spin { animation: dsh-rc-pill-spin 1s linear infinite; }
@keyframes dsh-rc-pill-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-rc-update-pill-spin { animation: none; } }
.dsh-rc-remote-ws-gear-dot { position: absolute; top: 2px; right: 1px; width: 5px; height: 5px; border-radius: 999px; box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-subtle, #161616); }
.dsh-rc-remote-ws-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: normal;
  text-transform: none;
  color: var(--dsw-alias-label-tertiary, #81858c);
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
.dsh-rc-remote-ws-bar { display: flex; align-items: center; gap: 8px; margin: 0 8px 4px 0; }
.dsh-rc-remote-ws-picker {
  display: block; flex: 1 1 auto; min-width: 0; height: 32px; margin: 0; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.28)); border-radius: var(--dsw-radius-md, 12px);
  background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 14px; line-height: 20px; cursor: pointer;
}
.dsh-rc-remote-ws-picker:focus-visible { outline: 2px solid var(--dsw-alias-focus-ring, #5b8def); outline-offset: 1px; }
.dsh-rc-inline-input {
  width: 100%; min-width: 0; height: 24px; padding: 0 6px; box-sizing: border-box; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-input, rgba(127,127,127,0.12));
  border: 1px solid var(--dsw-alias-focus-ring, #5b8def); border-radius: 6px; outline: none;
}
.dsh-rc-remote-ws-error { margin: 2px 8px 4px; font-size: 12px; color: #ef4444; }
/* Rows below copy DSH's own Workspaces list: same heights, spacing, type and tokens. */
.dsh-rc-remote-ws-group-add {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 16px; height: 16px; padding: 0; border: 0;
  border-radius: var(--dsw-radius-xs, 4px); background: transparent; color: var(--dsw-alias-label-tertiary, #81858c); cursor: pointer;
}
.dsh-rc-remote-ws-group-add:hover { color: var(--dsw-alias-label-primary, inherit); }
.dsh-rc-remote-ws-group {
  box-sizing: border-box; display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px; border-radius: var(--dsw-radius-md, 12px);
  color: var(--dsw-alias-label-primary, inherit); cursor: pointer; user-select: none;
}
.dsh-rc-remote-ws-group:hover, .dsh-rc-remote-ws-session:hover, .dsh-rc-remote-ws-session.dsh-rc-menu-open {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12));
}
.dsh-rc-remote-ws-group:focus-visible, .dsh-rc-remote-ws-session:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4c8dff); outline-offset: -2px; }
.dsh-rc-remote-ws-slot {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 16px; height: 20px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.dsh-rc-remote-ws-chevron { display: none; }
.dsh-rc-remote-ws-group:hover .dsh-rc-remote-ws-chevron { display: inline-flex; }
.dsh-rc-remote-ws-group:hover .dsh-rc-remote-ws-folder { display: none; }
.dsh-rc-remote-ws-group[aria-expanded="false"] .dsh-rc-remote-ws-chevron svg:not([data-native]) { transform: rotate(-90deg); }
/* DSH's own chevron points right at rest; it points down on an open workspace. */
.dsh-rc-remote-ws-group[aria-expanded="true"] .dsh-rc-remote-ws-chevron svg[data-native] { transform: rotate(90deg); }
.dsh-rc-remote-ws-group .dsh-rc-remote-ws-name { flex: 1 1 auto; font-size: 14px; line-height: 20px; }
.dsh-rc-remote-ws-group .dsh-rc-remote-ws-group-add { display: none; }
.dsh-rc-remote-ws-group:hover .dsh-rc-remote-ws-group-add, .dsh-rc-remote-ws-group:focus-within .dsh-rc-remote-ws-group-add { display: inline-flex; }
.dsh-rc-remote-ws-session {
  box-sizing: border-box; display: flex; align-items: center; gap: 0; width: 100%; height: 32px; padding: 0 8px; border: 0;
  border-radius: var(--dsw-radius-md, 12px); background: transparent; color: var(--dsw-alias-label-primary, inherit);
  font: inherit; text-align: left; cursor: pointer; user-select: none;
}
.dsh-rc-remote-ws-label {
  flex: 1 1 0%; min-width: 0; margin: 0 6px 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 20px;
}
.dsh-rc-remote-ws-pin { display: inline-flex; flex: 0 0 auto; margin-right: 4px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dsh-rc-remote-ws-actions { display: none; flex: 0 0 auto; align-items: center; gap: 15px; }
.dsh-rc-remote-ws-session:hover .dsh-rc-remote-ws-actions, .dsh-rc-remote-ws-session.dsh-rc-menu-open .dsh-rc-remote-ws-actions,
.dsh-rc-remote-ws-session:focus-within .dsh-rc-remote-ws-actions { display: inline-flex; }
.dsh-rc-remote-ws-session:hover .dsh-rc-remote-ws-age, .dsh-rc-remote-ws-session.dsh-rc-menu-open .dsh-rc-remote-ws-age,
.dsh-rc-remote-ws-session:focus-within .dsh-rc-remote-ws-age,
.dsh-rc-remote-ws-session:hover .dsh-rc-remote-ws-pin, .dsh-rc-remote-ws-session.dsh-rc-menu-open .dsh-rc-remote-ws-pin { display: none; }
.dsh-rc-remote-ws-icon {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 16px; height: 16px; padding: 0; border: 0;
  border-radius: var(--dsw-radius-xs, 4px); background: transparent; color: var(--dsw-alias-label-tertiary, #81858c); cursor: pointer;
}
.dsh-rc-remote-ws-icon:hover { color: var(--dsw-alias-label-primary, inherit); }
#dsh-rc-row-menu {
  position: absolute; z-index: 1000; min-width: 180px; max-width: 280px; max-height: min(60vh, 360px); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  padding: 4px; border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.22));
  border-radius: 10px; background: var(--dsw-alias-bg-elevated, #fff); box-shadow: 0 8px 24px rgba(0,0,0,0.16);
}
.dsh-rc-row-menu-heading { padding: 6px 10px 4px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dsh-rc-row-menu-item-icon { display: flex; align-items: center; gap: 8px; }
.dsh-rc-row-menu-item-icon svg { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #6b6f76); }
.dsh-rc-row-menu-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rc-row-menu-item {
  display: block; width: 100%; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-primary, #111); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.dsh-rc-row-menu-item:hover, .dsh-rc-row-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); outline: none; }
.dsh-rc-row-menu-sep { margin-top: 4px; position: relative; }
.dsh-rc-row-menu-sep::before { content: ''; position: absolute; left: 6px; right: 6px; top: -3px; border-top: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2)); }
@media (prefers-color-scheme: dark) { #dsh-rc-row-menu { background: var(--dsw-alias-bg-elevated, #1f2023); } .dsh-rc-row-menu-item { color: var(--dsw-alias-label-primary, #eee); } }
.dsh-rc-remote-ws-age { flex: 0 0 auto; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dsh-rc-remote-ws-more {
  height: 28px; margin: 0; padding: 0 8px 0 36px; border: 0; background: transparent; cursor: pointer;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-tertiary, #81858c);
}
.dsh-rc-remote-ws-note { margin: 0; padding: 2px 8px 2px 4px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dsh-rc-remote-ws-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rc-remote-ws-new {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 16px; height: 16px; padding: 0; border: 0;
  border-radius: var(--dsw-radius-xs, 4px); background: transparent; color: var(--dsw-alias-label-tertiary, #81858c); cursor: pointer;
}
.dsh-rc-remote-ws-new:hover { color: var(--dsw-alias-label-primary, inherit); }
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
      width: '600px',
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
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      gap: '8px 10px',
      marginTop: '12px',
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
    const [selectedHost, setSelectedHost] = ReactUse.useState(
      (() => { try { return globalThis.localStorage?.getItem('dsh-rc.remoteHost') ?? ''; } catch { return ''; } })() as string,
    );
    const [ownNameDraft, setOwnNameDraft] = ReactUse.useState(undefined as string | undefined);
    const [renameError, setRenameError] = ReactUse.useState(undefined as string | undefined);
    const [remoteSessions, setRemoteSessions] = ReactUse.useState({} as Record<string, { sessions?: RemoteSessionView[]; error?: string }>);
    const [showAll, setShowAll] = ReactUse.useState({} as Record<string, boolean>);
    const [embedUrl, setEmbedUrl] = ReactUse.useState(undefined as string | undefined);
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

    const saveOwnName = async (): Promise<void> => {
      const name = (ownNameDraft ?? '').trim();
      setOwnNameDraft(undefined);
      if (name === '' || status?.deviceId === undefined || name === status.deviceName) return;
      setBusy(true);
      setError(undefined);
      try {
        await call('computer.rename', { deviceId: status.deviceId, name });
        setStatus((await call('status')) as DshRcStatusView);
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setBusy(false);
      }
    };

    const setHost = async (enabled: boolean): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        setStatus((await call('host.set', { enabled })) as DshRcStatusView);
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setBusy(false);
      }
    };

    const updateSummary = (value: any): string => {
      const v = String(value?.latestVersion ?? '');
      const fill = (key: string): string => t(key).replace('{v}', v);
      const checked = typeof value?.updateCheckedAt === 'number' ? ` · ${t('updateCheckedAgo').replace('{age}', relativeAge(value.updateCheckedAt))}` : '';
      switch (value?.updateState) {
        case 'checking': return t('updateChecking');
        case 'available': return fill('updateAvailable');
        case 'installing': return fill('updateInstalling');
        case 'ready': return fill('updateReady');
        case 'restarting': return fill('updateRestarting');
        case 'development': return t('updateDevelopment');
        case 'error': return `${t('updateFailed')}${checked}`;
        default: return value?.updateCheckedAt === undefined ? t('updateNotChecked') : `${t('updateUpToDate')}${checked}`;
      }
    };

    const run = async (endpoint: 'start' | 'restart' | 'stop' | 'update.check' | 'update.restart'): Promise<void> => {
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

    const row = (label: string, value: any, mono = false): any =>
      h(
        'div',
        { className: `dsh-rc-status-cell${label === t('lastError') ? ' dsh-rc-status-cell-wide' : ''}`, key: `cell-${label}` },
        h('div', { className: 'dsh-rc-status-label' }, label),
        h('div', { className: `dsh-rc-status-value${mono ? ' dsh-rc-mono' : ''}`, title: typeof value === 'string' ? value : undefined }, value),
      );

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
    rows.push([t('updates'), updateSummary(status)]);
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

    const remoteMatch = typeof window !== 'undefined' ? /^\/d\/([^/]+)\//.exec(window.location.pathname) : null;
    const remoteDeviceId = remoteMatch?.[1];
    ReactUse.useEffect(() => {
      if (remoteDeviceId === undefined || typeof document === 'undefined') return undefined;
      let banner = document.getElementById('dsh-rc-remote-banner');
      if (banner === null) {
        banner = document.createElement('div');
        banner.id = 'dsh-rc-remote-banner';
        banner.className = 'dsh-rc-remote-banner';
        const title = document.createElement('div');
        title.className = 'dsh-rc-remote-banner-title';
        title.textContent = `${t('remoteBannerTitle')} · ${status?.deviceName ?? remoteDeviceId}`;
        const hint = document.createElement('div');
        hint.className = 'dsh-rc-remote-banner-hint';
        hint.textContent = t('remoteBannerHint');
        banner.append(title, hint);
        document.body.append(banner);
      }
      return () => banner?.remove();
    }, [remoteDeviceId, status?.deviceName, t]);

    const openHarness = (peer: HarnessPeerView, newSession = false, sessionId?: string): void => {
      if (peer.online !== true) {
        setError(`${peer.name} is offline. Start DeepSeek Harness on that computer, then try again.`);
        return;
      }
      void (async () => {
        try {
          const result = (await call('remote.embed', { deviceId: peer.id, newSession, ...(sessionId === undefined ? {} : { sessionId }) })) as { url?: string; opened?: boolean };
          if (typeof result.url === 'string' && result.url !== '') {
            props.openInSidebar(result.url);
            setOpen(false);
          }
        } catch (reason) {
          setError(messageOf(reason));
        }
      })();
    };

    // Sessions of every online Harness, refreshed while the sidebar is shown, so
    // remote sessions can be listed and opened like local ones.
    // Ask every online computer (other than this one) for its sessions: that both
    // fills the list and tells us which ones can actually be opened remotely.
    const onlineKey = harnessPeers
      .filter((peer: HarnessPeerView) => peer.online === true && peer.id !== status?.deviceId)
      .map((peer: HarnessPeerView) => peer.id)
      .join(',');
    ReactUse.useEffect(() => {
      if (onlineKey === '' || props.wide === false) return undefined;
      let cancelled = false;
      let inFlight = false;
      const load = (): void => {
        // Skip a tick while the previous request is still out (slow or offline peer).
        if (inFlight) return;
        inFlight = true;
        for (const id of onlineKey.split(',')) {
          void call('remote.sessions', { deviceId: id }).finally(() => { inFlight = false; }).then(
            (value: { sessions?: RemoteSessionView[] }) => {
              if (!cancelled) setRemoteSessions((previous: any) => ({ ...previous, [id]: { sessions: value.sessions ?? [] } }));
            },
            (reason: unknown) => {
              if (!cancelled) setRemoteSessions((previous: any) => ({ ...previous, [id]: { error: messageOf(reason) } }));
            },
          );
        }
      };
      load();
      const timer = setInterval(load, 20_000);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [onlineKey, props.wide, call]);

    // DSH's sidebar exposes `sidebar.workspaces` as a single slot occupied by
    // the native Workspaces section. Add a sibling inside the same region so
    // Remote Workspaces sits directly below it, and re-attach if React
    // reconciles the region.
    ReactUse.useEffect(() => {
      if (typeof document === 'undefined') return undefined;
      const slot = document.querySelector('[data-slot="sidebar.workspaces"]');
      if (slot === null) return undefined;
      // The local Workspaces list is the sidebar's one scroller; living at its
      // end makes Remote Workspaces scroll with it like any other section.
      const findScroller = (): HTMLElement | undefined => {
        for (const node of Array.from(slot.querySelectorAll('div'))) {
          if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
        }
        return undefined;
      };
      if (slot.parentElement === null) return undefined;
      let container = document.getElementById('dsh-rc-remote-workspaces');
      if (container === null) {
        container = document.createElement('div');
        container.id = 'dsh-rc-remote-workspaces';
        container.className = 'dsh-rc-remote-ws';
      }
      // Re-resolved on every attach: the host may mount or replace its list later.
      const attach = (): boolean => {
        const region = findScroller() ?? slot.parentElement;
        if (container === null || region === null) return false;
        if (container.parentElement === region && region.lastElementChild === container) return false;
        region.append(container);
        return true;
      };
      attach();
      const refreshPeer = (id: string): void => {
        void call('remote.sessions', { deviceId: id }).then(
          (value: { sessions?: RemoteSessionView[] }) => setRemoteSessions((previous: any) => ({ ...previous, [id]: { sessions: value.sessions ?? [] } })),
          (reason: unknown) => setRenameError(messageOf(reason)),
        );
      };
      const render = (): void => {
        if (container === null || inlineEditing) return;
        container.replaceChildren();
        container.style.display = props.wide === false ? 'none' : '';
        if (props.wide === false) return;
        const header = document.createElement('div');
        header.className = 'dsh-rc-remote-ws-header';
        const title = document.createElement('span');
        title.className = 'dsh-rc-remote-ws-title';
        title.textContent = t('remoteWorkspaces');
        const gear = document.createElement('button');
        gear.type = 'button';
        gear.className = 'dsh-rc-remote-ws-gear';
        gear.title = `${t('title')} · ${stateLabel}`;
        gear.setAttribute('aria-label', t('title'));
        const gearIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        gearIcon.setAttribute('viewBox', '0 0 24 24');
        gearIcon.setAttribute('width', '15');
        gearIcon.setAttribute('height', '15');
        gearIcon.setAttribute('fill', 'none');
        gearIcon.setAttribute('stroke', 'currentColor');
        gearIcon.setAttribute('stroke-width', '1.7');
        gearIcon.setAttribute('stroke-linecap', 'round');
        gearIcon.setAttribute('stroke-linejoin', 'round');
        gearIcon.setAttribute('aria-hidden', 'true');
        const gearPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        gearPath.setAttribute('d', 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z');
        gearIcon.append(gearPath);
        const gearDot = document.createElement('span');
        gearDot.className = 'dsh-rc-remote-ws-gear-dot';
        gearDot.style.background = color;
        gear.append(gearIcon, gearDot);
        gear.addEventListener('click', () => setOpen(true));
        const pill = updatePill(status, t, (endpoint) => {
          void call(endpoint).then((next) => setStatus(next as DshRcStatusView)).catch(() => undefined);
        });
        header.append(...(pill === null ? [title, gear] : [title, pill, gear]));
        container.append(header);
        if (harnessPeers.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dsh-rc-remote-ws-empty';
          empty.textContent = t('remoteWorkspacesEmpty');
          container.append(empty);
          return;
        }
        if (renameError !== undefined) {
          const failed = document.createElement('div');
          failed.className = 'dsh-rc-remote-ws-error';
          failed.textContent = renameError;
          container.append(failed);
        }
        const afterRename = (error?: string): void => {
          setRenameError(error);
          setHarnessPeers((previous: HarnessPeerView[]) => [...previous]);
          setRemoteSessions((previous: any) => ({ ...previous }));
        };
        // A plugin update replaces this screen at once, but the background host
        // keeps the old code until Harness restarts; the two cannot talk then.
        if (status?.version !== undefined && status.version !== PLUGIN_VERSION) {
          const stale = document.createElement('div');
          stale.className = 'dsh-rc-remote-ws-note';
          stale.style.marginLeft = '8px';
          stale.textContent = t('remoteRestartNeeded');
          container.append(stale);
          return;
        }
        // Only computers you can remote to: online, not this one, and answering
        // with their sessions (a computer on an older plugin cannot be opened).
        const others = harnessPeers.filter((peer: HarnessPeerView) =>
          peer.id !== status?.deviceId && peer.online === true && remoteSessions[peer.id]?.sessions !== undefined);
        const peer = others.find((candidate: HarnessPeerView) => candidate.id === selectedHost) ?? (others.length === 1 ? others[0] : undefined);
        if (others.length === 0) {
          const hint = document.createElement('div');
          hint.className = 'dsh-rc-remote-ws-note';
          hint.style.marginLeft = '8px';
          hint.textContent = t('remoteNoneOnline');
          container.append(hint);
          return;
        }
        const bar = document.createElement('div');
        bar.className = 'dsh-rc-remote-ws-bar';
        const picker = document.createElement('select');
        picker.className = 'dsh-rc-remote-ws-picker';
        picker.setAttribute('aria-label', t('remotePick'));
        if (peer === undefined) {
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = t('remotePick');
          picker.append(placeholder);
        }
        for (const candidate of others) {
          const option = document.createElement('option');
          option.value = candidate.id;
          option.textContent = candidate.name;
          picker.append(option);
        }
        picker.value = peer?.id ?? '';
        picker.addEventListener('change', () => {
          try { globalThis.localStorage?.setItem('dsh-rc.remoteHost', picker.value); } catch { /* optional */ }
          setSelectedHost(picker.value);
        });
        bar.append(picker);
        if (peer === undefined) {
          container.append(bar);
          const hint = document.createElement('div');
          hint.className = 'dsh-rc-remote-ws-note';
          hint.style.marginLeft = '8px';
          hint.textContent = t('remotePickHint');
          container.append(hint);
          return;
        }
        const iconButton = (label: string, glyph: SVGSVGElement, onClick: () => void): HTMLButtonElement => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dsh-rc-remote-ws-new';
          button.append(glyph);
          button.title = label;
          button.setAttribute('aria-label', label);
          button.addEventListener('click', onClick);
          return button;
        };
        const rename = iconButton(t('remoteRenameComputer'), rowIcon('pencil', 16), () => {
          const slot = document.createElement('span');
          slot.style.flex = '1 1 auto';
          slot.style.minWidth = '0';
          bar.replaceChild(slot, picker);
          editInline(slot, peer.name, 64, async (value) => { await call('computer.rename', { deviceId: peer.id, name: value }); }, afterRename);
        });
        /** The peer's project folders; a peer on an older version falls back to folders known from its sessions. */
        const loadRemoteWorkspaces = async (deviceId: string): Promise<Array<{ workspaceId: string; workspaceName: string }>> => {
          const fromSessions = (): Array<{ workspaceId: string; workspaceName: string }> => {
            const seen = new Map<string, string>();
            for (const row of remoteSessions[deviceId]?.sessions ?? []) if (!seen.has(row.workspaceId)) seen.set(row.workspaceId, row.workspaceName);
            return [...seen].map(([workspaceId, workspaceName]) => ({ workspaceId, workspaceName }));
          };
          try {
            const value = (await call('session.workspaces', { deviceId })) as { workspaces?: unknown };
            const rows = Array.isArray(value?.workspaces) ? value.workspaces : [];
            const folders = rows.flatMap((row: any) => (typeof row?.workspaceId === 'string' && row.workspaceId !== ''
              ? [{ workspaceId: row.workspaceId as string, workspaceName: typeof row.workspaceName === 'string' && row.workspaceName !== '' ? row.workspaceName as string : row.workspaceId as string }]
              : []));
            return folders.length > 0 ? folders : fromSessions();
          } catch {
            return fromSessions();
          }
        };
        const add = iconButton(t('remoteNewSession'), nativeRowIcon(slot, 'newSession', true) ?? rowIcon('plus', 16), () => {
          // Ask which project folder: the remote computer's own workspace list (empty folders included).
          if (add.getAttribute('aria-busy') === 'true') return;
          add.setAttribute('aria-busy', 'true');
          void loadRemoteWorkspaces(peer.id).then((folders) => {
            add.removeAttribute('aria-busy');
            if (folders.length === 0) {
              setRenameError(t('remoteNoWorkspace'));
              return;
            }
            props.newRemoteSession(peer.id, peer.name, folders);
          }).catch((reason: unknown) => {
            add.removeAttribute('aria-busy');
            setRenameError(messageOf(reason));
          });
        });
        add.setAttribute('aria-haspopup', 'menu');
        bar.append(rename, add);
        container.append(bar);
        {
          {
            const entry = remoteSessions[peer.id];
            if (entry === undefined) {
              const note = document.createElement('div');
              note.className = 'dsh-rc-remote-ws-note';
              note.textContent = t('remoteSessionsLoading');
              container.append(note);
            } else if (entry.error !== undefined) {
              const note = document.createElement('div');
              note.className = 'dsh-rc-remote-ws-note';
              note.textContent = t('remoteSessionsUnavailable');
              note.title = entry.error;
              container.append(note);
            } else if ((entry.sessions ?? []).length === 0) {
              const note = document.createElement('div');
              note.className = 'dsh-rc-remote-ws-note';
              note.textContent = t('remoteSessionsEmpty');
              container.append(note);
            } else {
              const all = entry.sessions ?? [];
              const visible = showAll[peer.id] === true ? all : all.slice(0, 8);
              const renderSession = (session: RemoteSessionView): void => {
                const item = document.createElement('div');
                item.setAttribute('role', 'button');
                item.tabIndex = 0;
                item.className = 'dsh-rc-remote-ws-session';
                item.title = `${session.title} · ${peer.name}`;
                const lead = document.createElement('span');
                lead.className = 'dsh-rc-remote-ws-slot';
                const label = document.createElement('span');
                label.className = 'dsh-rc-remote-ws-label';
                label.textContent = session.title;
                const age = document.createElement('span');
                age.className = 'dsh-rc-remote-ws-age';
                age.textContent = session.updatedAt === null ? '' : relativeAge(session.updatedAt);
                const rename = (): void => editInline(label, session.title, 200, async (value) => { await call('session.rename', { deviceId: peer.id, sessionId: session.id, title: value }); }, afterRename);
                const organize = (action: 'archive' | 'pin' | 'unpin'): void => {
                  void call('session.organize', { deviceId: peer.id, sessionId: session.id, action })
                    .then(() => refreshPeer(peer.id), (reason: unknown) => setRenameError(messageOf(reason)));
                };
                const pinIcon = session.pinned === true ? 'unpin' : 'pin';
                const actions = document.createElement('span');
                actions.className = 'dsh-rc-remote-ws-actions';
                const more = rowIconButton('more', t('rowActionsFor').replace('{name}', session.title));
                more.addEventListener('click', (event: MouseEvent) => {
                  event.stopPropagation();
                  item.classList.add('dsh-rc-menu-open');
                  openRowMenu(more, [
                    { label: session.pinned === true ? t('rowUnpin') : t('rowPin'), run: () => organize(pinIcon) },
                    { label: t('rowRename'), run: rename },
                    { label: t('rowArchive'), run: () => organize('archive'), separator: true },
                    { label: t('rowCopyId'), run: () => { void navigator.clipboard?.writeText(session.id); } },
                  ], () => item.classList.remove('dsh-rc-menu-open'));
                });
                const archive = rowIconButton('archive', t('rowArchive'));
                archive.addEventListener('click', (event: MouseEvent) => { event.stopPropagation(); organize('archive'); });
                const pin = rowIconButton(pinIcon, session.pinned === true ? t('rowUnpin') : t('rowPin'));
                pin.addEventListener('click', (event: MouseEvent) => { event.stopPropagation(); organize(pinIcon); });
                actions.append(more, archive, pin);
                // Strip clicks must not open or rename the row.
                actions.addEventListener('dblclick', (event: MouseEvent) => event.stopPropagation());
                if (session.pinned === true) item.classList.add('dsh-rc-remote-ws-pinned');
                const tail: Node[] = [];
                if (session.pinned === true) {
                  const mark = rowIcon('pin', 12);
                  mark.classList.add('dsh-rc-remote-ws-pin');
                  tail.push(mark);
                }
                item.append(lead, label, ...tail, age, actions);
                item.title = `${session.title} - ${t('renameHint')}`;
                clickOrDouble(
                  item,
                  () => props.openRemoteSession({ deviceId: peer.id, deviceName: peer.name, sessionId: session.id, title: session.title }),
                  rename,
                );
                container?.append(item);
              };
              // Group by workspace, most recently active workspace first.
              const groups = new Map<string, RemoteSessionView[]>();
              for (const session of visible) {
                const bucket = groups.get(session.workspaceId) ?? [];
                bucket.push(session);
                groups.set(session.workspaceId, bucket);
              }
              for (const bucket of groups.values()) {
                const groupKey = `${peer.id}|${bucket[0]?.workspaceId ?? ''}`;
                const collapsed = collapsedRemoteGroups.has(groupKey);
                const group = document.createElement('div');
                group.className = 'dsh-rc-remote-ws-group';
                group.setAttribute('role', 'button');
                group.tabIndex = 0;
                group.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                // Same leading seat as a local workspace: folder at rest, chevron on hover.
                const folder = document.createElement('span');
                folder.className = 'dsh-rc-remote-ws-slot dsh-rc-remote-ws-folder';
                folder.append(nativeRowIcon(slot, collapsed ? 'folder' : 'folderOpen', !collapsed) ?? rowIcon(collapsed ? 'folder' : 'folderOpen', 16));
                const chevron = document.createElement('span');
                chevron.className = 'dsh-rc-remote-ws-slot dsh-rc-remote-ws-chevron';
                chevron.append(nativeRowIcon(slot, 'chevron', !collapsed) ?? rowIcon('chevron', 16));
                const groupName = document.createElement('span');
                groupName.className = 'dsh-rc-remote-ws-name';
                groupName.textContent = bucket[0]?.workspaceName ?? '';
                const toggle = (): void => {
                  if (collapsedRemoteGroups.has(groupKey)) collapsedRemoteGroups.delete(groupKey);
                  else collapsedRemoteGroups.add(groupKey);
                  saveCollapsedRemoteGroups();
                  render();
                };
                group.addEventListener('click', toggle);
                group.addEventListener('keydown', (event: KeyboardEvent) => {
                  if (event.target !== group) return;
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
                });
                const groupAdd = document.createElement('button');
                groupAdd.type = 'button';
                groupAdd.className = 'dsh-rc-remote-ws-group-add';
                groupAdd.append(nativeRowIcon(slot, 'newSession', true) ?? rowIcon('plus', 16));
                groupAdd.title = t('remoteNewSessionIn').replace('{name}', bucket[0]?.workspaceName ?? '');
                groupAdd.setAttribute('aria-label', groupAdd.title);
                groupAdd.addEventListener('click', (event: MouseEvent) => {
                  event.stopPropagation();
                  const workspaceId = bucket[0]?.workspaceId;
                  if (workspaceId === undefined) return;
                  // Every folder stays choosable; this workspace is preselected.
                  void loadRemoteWorkspaces(peer.id).then((folders) => {
                    const list = folders.some((row) => row.workspaceId === workspaceId) ? folders : [{ workspaceId, workspaceName: bucket[0]?.workspaceName ?? workspaceId }, ...folders];
                    props.newRemoteSession(peer.id, peer.name, list, workspaceId);
                  });
                });
                group.append(folder, chevron, groupName, groupAdd);
                container.append(group);
                if (!collapsed) for (const session of bucket) renderSession(session);
              }
              if (all.length > 8) {
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'dsh-rc-remote-ws-more';
                more.textContent = showAll[peer.id] === true ? t('remoteShowLess') : t('remoteShowAll').replace('{count}', String(all.length));
                more.addEventListener('click', () => setShowAll((previous: any) => ({ ...previous, [peer.id]: previous[peer.id] !== true })));
                container.append(more);
              }
            }
          }
        }
      };
      render();
      const observer = new MutationObserver((records: MutationRecord[]) => {
        // Our own renders happen inside the container; only host changes matter.
        if (records.every((record) => container?.contains(record.target) === true)) return;
        // React adds or drops local rows; keep this section last, after them.
        if (attach()) render();
      });
      observer.observe(slot, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        container?.remove();
      };
    }, [harnessPeers, selectedHost, renameError, status?.deviceId, remoteSessions, showAll, harnessPublicUrl, props.wide, status?.edgeUrl, status?.version, (status as any)?.updateState, (status as any)?.updatePercent, (status as any)?.latestVersion, (status as any)?.updateMessage, t, stateLabel, color, setOpen]);

    return h(
      'div',
      null,
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
              (status?.updateState === 'available' || status?.updateState === 'installing' || status?.updateState === 'ready' || status?.updateState === 'restarting' || status?.updateState === 'error') && status.updateMessage !== undefined
                ? h('div', { style: styles.banner('#38bdf8') }, redact(status.updateMessage))
                : null,
              h(
                'div',
                {
                  style: {
                    display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', margin: '0 0 12px',
                    border: '1px solid rgba(127,127,127,0.28)', borderRadius: '10px',
                  },
                },
                h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0 } },
                  h('div', { style: { fontSize: '13px', fontWeight: 600 } }, t('shareTitle'), ' · ', status?.hostEnabled === false ? t('shareStateOff') : t('shareStateOn')),
                  h(
                    'div',
                    { style: { fontSize: '12px', color: '#a1a1aa', marginTop: '2px' } },
                    status?.hostEnabled === false ? t('shareOff') : t('shareOn').replace('{name}', redact(status?.deviceName ?? '')),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' } },
                    ownNameDraft === undefined
                      ? h(
                          'span',
                          {
                            title: t('renameHint'),
                            onDoubleClick: () => setOwnNameDraft(status?.deviceName ?? ''),
                            style: { fontSize: '12.5px', fontWeight: 600 },
                          },
                          redact(status?.deviceName ?? '—'),
                        )
                      : h('input', {
                          autoFocus: true,
                          value: ownNameDraft,
                          maxLength: 64,
                          'aria-label': t('device'),
                          onChange: (event: any) => setOwnNameDraft(event.target.value),
                          onKeyDown: (event: any) => {
                            if (event.key === 'Enter') void saveOwnName();
                            else if (event.key === 'Escape') setOwnNameDraft(undefined);
                          },
                          onBlur: () => void saveOwnName(),
                          style: { height: '24px', fontSize: '12.5px', padding: '0 6px', borderRadius: '6px', minWidth: '160px' },
                        }),
                    ownNameDraft === undefined
                      ? h(
                          'button',
                          {
                            type: 'button',
                            disabled: busy || unavailable || status?.deviceId === undefined,
                            onClick: () => setOwnNameDraft(status?.deviceName ?? ''),
                            style: { fontSize: '12px', border: 0, background: 'transparent', color: '#60a5fa', cursor: 'pointer', padding: 0 },
                          },
                          t('renameComputer'),
                        )
                      : null,
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'switch',
                    'aria-checked': status?.hostEnabled !== false,
                    'aria-label': t('shareTitle'),
                    disabled: busy || unavailable,
                    onClick: () => void setHost(status?.hostEnabled === false),
                    style: {
                      flex: '0 0 auto', width: '40px', height: '22px', borderRadius: '11px', border: 0, padding: '2px',
                      cursor: 'pointer', background: status?.hostEnabled === false ? 'rgba(127,127,127,0.45)' : '#22c55e',
                      display: 'flex', justifyContent: status?.hostEnabled === false ? 'flex-start' : 'flex-end', transition: 'background 120ms',
                    },
                  },
                  h('span', { style: { width: '18px', height: '18px', borderRadius: '9px', background: '#fff', display: 'block' } }),
                ),
              ),
              h(
                'div',
                { style: styles.grid },
                ...rows.map(([label, value, mono]) => row(label as string, value, mono === true)),
              ),
              h(
                'div',
                { style: { ...styles.actions, marginTop: '10px' } },
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('start') }, t('start')),
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('restart') }, t('restart')),
                h('button', { type: 'button', style: styles.button(false), disabled, onClick: () => void run('stop') }, t('stop')),
                status?.updateState === 'development' ? null : h('button', { type: 'button', style: styles.button(false), disabled: disabled || status?.updateState === 'installing' || status?.updateState === 'checking', onClick: () => void run('update.check') }, t('updateCheck')),
                status?.updateState === 'ready' ? h('button', { type: 'button', style: styles.button(true), disabled, onClick: () => void run('update.restart') }, t('updateRestart')) : null,
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
      const wantedSession = params.get('dsh-rc-session');
      if (wantedSession !== null && wantedSession !== '') {
        params.delete('dsh-rc-session');
        const rest = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${rest === '' ? '' : `?${rest}`}${window.location.hash}`);
        // The catalog loads after boot; keep trying until the session opens.
        let attempts = 0;
        const timer = setInterval(() => {
          attempts += 1;
          try {
            const workspace = ctx.uiWorkspace as { openSession?: (target: unknown) => unknown } | undefined;
            if (typeof workspace?.openSession === 'function') {
              workspace.openSession(wantedSession);
              clearInterval(timer);
              return;
            }
          } catch { /* not ready yet */ }
          if (attempts >= 40) clearInterval(timer);
        }, 500);
      }
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

  // Remote sessions open inside DSH itself, as a tab of the built-in Browser
  // sidebar (a lease-approved webview that supports loopback pages), never as a
  // tab of the system browser.
  const openInSidebar = (url: string): void => {
    if (ctx.sidebarRight === undefined) throw new Error('The DSH sidebar browser is not available in this window.');
    const sidebar = ctx.sidebarRight;
    // Reuse the tab if this remote is already open instead of stacking copies.
    sidebar.openTab('browser', { params: { url }, revealIfOpened: true });
    // A narrow side column squeezes the remote Harness into its phone layout, so
    // widen the panel over the conversation (DSH's own fullscreen mode).
    const widen = (attempt: number): void => {
      try {
        const panel = document.querySelector('[data-sidebar-right-panel]');
        if (panel === null) {
          if (attempt < 10) setTimeout(() => widen(attempt + 1), 100);
          return;
        }
        if (panel.getAttribute('data-sidebar-right-panel') === 'fullscreen') return;
        const target = sidebar.commandTarget?.();
        if (target !== undefined && target !== null) sidebar.toggleFullscreen?.(target);
      } catch { /* the tab is open; widening is cosmetic */ }
    };
    setTimeout(() => widen(0), 150);
  };

  // Remote sessions open in DSH's main area, where local conversations render.
  const openRemoteSession = (target: RemoteTarget): void => {
    remoteChatStore.set(target);
    ctx.layout?.selectPanel(REMOTE_PANEL_ID);
  };
  // New Remote Session: folder, model and effort, permissions; an older computer offers the folder only.
  const newRemoteSession = (deviceId: string, deviceName: string, folders: Array<{ workspaceId: string; workspaceName: string }>, initialFolder?: string): void => {
    openNewSessionDialog({
      t,
      deviceName,
      folders,
      ...(initialFolder === undefined ? {} : { initialFolder }),
      loadConfig: async () => parseConfig(await call('session.config', { deviceId })),
      status: () => call('session.status', { deviceId }),
      update: () => call('session.update', { deviceId }),
      create: async (choice: NewSessionChoice) => {
        const created = (await call('session.create', { deviceId, ...choice })) as { sessionId?: string; warnings?: unknown };
        if (typeof created.sessionId !== 'string') throw new Error('The new session was not created.');
        const warnings = Array.isArray(created.warnings) ? created.warnings.filter((item): item is string => typeof item === 'string') : [];
        openRemoteSession({ deviceId, deviceName, sessionId: created.sessionId, title: '', ...(warnings.length === 0 ? {} : { notice: warnings.join(' ') }) });
      },
    });
  };
  // Escape hatch for files and terminal: the remote's own full interface.
  const openFullView = (target: RemoteTarget): void => {
    void call('remote.embed', { deviceId: target.deviceId, sessionId: target.sessionId }).then(
      (result: { url?: string }) => { if (typeof result.url === 'string') openInSidebar(result.url); },
      () => undefined,
    );
  };
  // Test hook for the end-to-end probe (tools/e2e/remote-chat.mjs). It only
  // opens the view; every call behind it is still authenticated by the host.
  (globalThis as unknown as Record<string, unknown>)['__DSH_RC_OPEN_REMOTE__'] = openRemoteSession;
  const remoteChat = createRemoteChat(requireReact());
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: REMOTE_PANEL_ID, locale: LOCALE_NAMESPACE, inject: () => ({ call, t, openFullView }) },
      remoteChat,
    ),
  );

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'dsh-rc',
        order: 40,
        locale: LOCALE_NAMESPACE,
        inject: () => ({ call, t, openInSidebar, openRemoteSession, newRemoteSession }),
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
      exports.inject = ['connection', 'slots', 'locale', 'layout', 'sidebarRight', 'uiWorkspace'];
      return module.exports;
    },
  });
}

loadModule();

export {};