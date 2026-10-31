/**
 * Model, effort and permission controls for remote sessions, matching the
 * local composer: a Permissions chip on the left, a model + effort chip on
 * the right, each opening a menu with a check on the current choice.
 *
 * Framework-free DOM so the sidebar (plain DOM) and the remote conversation
 * (React) share one implementation. Nothing here builds markup from strings.
 */

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface EffortOption { id: string; name: string; description?: string }
export interface ModelOption { id: string; name: string; description?: string; efforts: EffortOption[]; defaultEffort?: string }
export interface ModelGroup { id: string; name: string; models: ModelOption[] }
export interface PermissionOption { value: string; name: string; description?: string; dangerous?: boolean }

export interface SessionConfig {
  models: { groups: ModelGroup[]; default: ModelSelection | null };
  permissions: { options: PermissionOption[]; defaultPreset: string | null } | null;
  session?: { model: ModelSelection | null; permission: string | null };
}

type T = (key: string) => string;

export const SETTINGS_LOCALE_EN: Record<string, string> = {
  settingsPermissions: 'Permissions',
  settingsModel: 'Model',
  settingsEffort: 'Effort',
  settingsModelAndEffort: 'Model and Reasoning Effort',
  settingsProjectFolder: 'Project Folder',
  settingsNewSessionTitle: 'New Remote Session',
  settingsNewSessionOn: 'Runs on {name}, in the folder you choose.',
  settingsCreate: 'Create Session',
  settingsCreating: 'Creating…',
  settingsClose: 'Close',
  settingsCancel: 'Cancel',
  settingsDefault: 'Default',
  settingsCustom: 'Custom',
  settingsNoModels: 'No models are available on that computer.',
  settingsUnavailable: 'That computer is on an older version: only the folder can be chosen. It updates by itself.',
  settingsFullAccessTitle: 'Turn On Full Access?',
  settingsFullAccessBody: 'Full access lets the agent on that computer act with fewer confirmations, including file changes, sensitive operations and external commands. Only use it when you trust the task.',
  settingsFullAccessConfirm: 'Turn On Full Access',
  settingsPermissionReadOnly: 'Read Only',
  settingsPermissionReadOnlyHint: 'The agent can read files but asks before changing anything.',
  settingsPermissionWorkspaceWrite: 'Workspace Write',
  settingsPermissionWorkspaceWriteHint: 'The agent can edit files in the project folder and asks before anything else.',
  settingsPermissionFullAccess: 'Full Access',
  settingsPermissionFullAccessHint: 'The agent acts with the fewest confirmations.',
  settingsPermissionAuto: 'Auto Review',
  settingsPermissionAutoHint: 'Full access, with each risky step reviewed automatically.',
  settingsOutdated: '{name} runs DSH RC {version}. Model, effort and permissions need 0.4.2 or later.',
  settingsOutdatedUnknown: '{name} is on an older DSH RC. Model, effort and permissions need 0.4.2 or later.',
  settingsUpdateRemote: 'Update That Computer',
  settingsUpdating: 'Updating…',
  settingsUpdateAsked: 'Update requested. {name} installs it and restarts when no session there is working.',
  settingsUpdateByHand: 'That computer is too old to update from here. On {name}, quit and reopen DeepSeek Harness once; from then on it updates by itself.',
  settingsLoadFailed: 'Settings could not be loaded from {name}.',
  settingsUpdateFailed: 'The update request did not reach {name}. Try again in a moment.',
};

export const SETTINGS_LOCALE_ZH: Record<string, string> = {
  settingsPermissions: '权限',
  settingsModel: '模型',
  settingsEffort: '推理强度',
  settingsModelAndEffort: '模型和推理强度',
  settingsProjectFolder: '项目文件夹',
  settingsNewSessionTitle: '新建远程会话',
  settingsNewSessionOn: '在 {name} 上运行，位于你选择的文件夹。',
  settingsCreate: '创建会话',
  settingsCreating: '正在创建…',
  settingsClose: '关闭',
  settingsCancel: '取消',
  settingsDefault: '默认',
  settingsCustom: '自定义',
  settingsNoModels: '那台电脑上没有可用的模型。',
  settingsUnavailable: '那台电脑的版本较旧：只能选择文件夹。它会自动更新。',
  settingsFullAccessTitle: '开启完全访问？',
  settingsFullAccessBody: '完全访问会让那台电脑上的智能体减少确认步骤，直接执行更多操作，包括文件修改、敏感操作和外部命令。仅在信任该任务时使用。',
  settingsFullAccessConfirm: '开启完全访问',
  settingsPermissionReadOnly: '只读',
  settingsPermissionReadOnlyHint: '智能体可以读取文件，修改前会先询问。',
  settingsPermissionWorkspaceWrite: '工作区可写',
  settingsPermissionWorkspaceWriteHint: '智能体可以编辑项目文件夹中的文件，其他操作会先询问。',
  settingsPermissionFullAccess: '完全访问',
  settingsPermissionFullAccessHint: '智能体以最少的确认执行操作。',
  settingsPermissionAuto: '自动审查',
  settingsPermissionAutoHint: '完全访问，每个有风险的步骤都会自动审查。',
  settingsOutdated: '{name} 运行的是 DSH RC {version}。模型、推理强度和权限需要 0.4.2 或更高版本。',
  settingsOutdatedUnknown: '{name} 的 DSH RC 版本较旧。模型、推理强度和权限需要 0.4.2 或更高版本。',
  settingsUpdateRemote: '更新那台电脑',
  settingsUpdating: '正在更新…',
  settingsUpdateAsked: '已请求更新。{name} 会安装更新，并在没有会话运行时重启。',
  settingsUpdateByHand: '那台电脑版本太旧，无法从这里更新。请在 {name} 上退出并重新打开 DeepSeek Harness 一次，之后它会自动更新。',
  settingsLoadFailed: '无法从 {name} 读取设置。',
  settingsUpdateFailed: '更新请求未能到达 {name}，请稍后再试。',
};

/** Harness preset keys with the local picker's wording; others keep the computer's own label. */
const PRESET_KEYS: Record<string, string> = {
  'read-only': 'settingsPermissionReadOnly',
  'workspace-write': 'settingsPermissionWorkspaceWrite',
  'danger-full-access': 'settingsPermissionFullAccess',
  auto: 'settingsPermissionAuto',
};

/** Whether a preset leaves the sandbox: the computer's own flag, else the well-known names. */
export function isFullAccess(preset: string | null | undefined, config?: SessionConfig): boolean {
  const flagged = config?.permissions?.options.find((option) => option.value === preset)?.dangerous;
  if (flagged !== undefined) return flagged;
  return preset === 'danger-full-access' || preset === 'auto';
}

export function permissionLabel(t: T, option: PermissionOption | undefined, value: string | null): string {
  if (value === null || value === 'custom') return t('settingsCustom');
  const key = PRESET_KEYS[value];
  return key === undefined ? option?.name ?? value : t(key);
}

function permissionHint(t: T, option: PermissionOption): string | undefined {
  const key = PRESET_KEYS[option.value];
  return key === undefined ? option.description : t(`${key}Hint`);
}

export function findModel(config: SessionConfig, selection: ModelSelection | null): ModelOption | undefined {
  if (selection === null) return undefined;
  return config.models.groups.find((group) => group.id === selection.provider)?.models.find((model) => model.id === selection.model);
}

/** Model label and effort caption for a chip, e.g. "DeepSeek-V4.1-Flash" + "Low". */
export function modelLabel(config: SessionConfig, selection: ModelSelection | null): { model: string; effort: string } {
  const model = findModel(config, selection);
  const effortId = selection?.reasoningEffort ?? model?.defaultEffort;
  const effort = model?.efforts.find((candidate) => candidate.id === effortId)?.name ?? '';
  return { model: model?.name ?? selection?.model ?? '', effort };
}

/**
 * DSH shows a model's release tag as a small pill ("DeepSeek-V4.1-Flash" + "1017").
 * The tag is a trailing 4-digit token of the name, or of the id when the name lacks it.
 */
export function splitModelBadge(name: string, id: string): { name: string; badge: string } {
  // A year ("Model 2025") is part of the name, not a release tag.
  const isYear = (tag: string | undefined): boolean => tag !== undefined && /^(19|20)\d\d$/.test(tag);
  const fromName = /^(.*\S)[\s-]+(\d{4})$/.exec(name);
  if (fromName !== null && !isYear(fromName[2])) return { name: fromName[1] ?? name, badge: fromName[2] ?? '' };
  const fromId = /[-_](\d{4})$/.exec(id);
  return { name, badge: fromId === null || isYear(fromId[1]) || fromName !== null ? '' : fromId[1] ?? '' };
}

/** Keep a selection valid when the model changes: same effort if offered, else the model's default. */
export function withModel(model: ModelOption, provider: string, effort: string | undefined): ModelSelection {
  const keep = effort !== undefined && model.efforts.some((candidate) => candidate.id === effort) ? effort : model.defaultEffort;
  return { provider, model: model.id, ...(keep === undefined ? {} : { reasoningEffort: keep }) };
}

/** The values a new session starts with: the computer's own defaults. */
export function initialChoices(config: SessionConfig): { model: ModelSelection | null; permission: string | null } {
  let model = config.models.default;
  const known = findModel(config, model);
  if (known === undefined) {
    const group = config.models.groups[0];
    const first = group?.models[0];
    model = group === undefined || first === undefined ? null : withModel(first, group.id, undefined);
  } else if (model !== null && model.reasoningEffort === undefined && known.defaultEffort !== undefined) {
    model = { ...model, reasoningEffort: known.defaultEffort };
  }
  const permissions = config.permissions;
  const permission = permissions === null ? null : permissions.defaultPreset ?? permissions.options[0]?.value ?? null;
  return { model, permission };
}

/** Parse a peer's `remote.config` answer defensively; undefined when it is unusable. */
export function parseConfig(value: unknown): SessionConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, any>;
  if (typeof record['models'] !== 'object' || record['models'] === null || !Array.isArray(record['models'].groups)) return undefined;
  return record as SessionConfig;
}

/* ------------------------------- icons -------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(kind: 'shield' | 'shieldAlert' | 'chevron' | 'check' | 'x', size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths: Record<string, string[]> = {
    shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
    shieldAlert: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'M12 8v4', 'M12 16h.01'],
    chevron: ['m6 9 6 6 6-6'],
    check: ['M20 6 9 17l-5-5'],
    x: ['M18 6 6 18', 'm6 6 12 12'],
  };
  for (const d of paths[kind] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/* ------------------------------- styles ------------------------------- */

export const SESSION_SETTINGS_CSS = `
.dsh-rc-set-bar { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dsh-rc-set-spacer { flex: 1 1 auto; }
.dsh-rc-set-trigger { min-width: 0; max-width: min(360px, 45vw); height: 28px; display: inline-flex; align-items: center; gap: 4px; padding: 0 4px 0 8px; border: 0; outline: none; background: transparent; border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-secondary, #6b7280); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.dsh-rc-set-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dsh-rc-set-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b5bdb)); }
.dsh-rc-set-trigger:disabled { color: var(--dsw-alias-label-dimmed, #9ca3af); cursor: default; }
.dsh-rc-set-trigger svg { flex: none; }
.dsh-rc-set-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rc-set-badge { flex: none; height: 18px; display: inline-flex; align-items: center; padding: 0 5px; border-radius: 5px; background: var(--dsw-alias-state-business-bg, rgba(77,107,254,0.1)); color: var(--dsw-alias-state-business-primary, #4d6bfe); font-size: 11px; font-weight: 500; line-height: 18px; font-variant-numeric: tabular-nums; }
.dsh-rc-set-effort { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1000; color: var(--dsw-alias-label-caption, #9ca3af); }
.dsh-rc-set-chevron { color: var(--dsw-alias-label-caption, #9ca3af); transition: transform .12s; }
@media (prefers-reduced-motion: reduce) { .dsh-rc-set-chevron { transition: none; } }
.dsh-rc-set-trigger[aria-expanded="true"] .dsh-rc-set-chevron { transform: rotate(180deg); }
.dsh-rc-set-menu { position: fixed; z-index: 1300; display: flex; flex-direction: column; width: max-content; min-width: min(240px, calc(100vw - 32px)); max-width: min(420px, calc(100vw - 32px)); max-height: min(360px, calc(100vh - 96px)); overflow-y: auto; overscroll-behavior: contain; padding: 4px; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-popover, var(--dsw-alias-bg-primary, #fff)); color: var(--dsw-alias-label-primary, #111); box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,0.18)); border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2)); }
.dsh-rc-set-menu-heading { padding: 6px 8px 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-rc-set-menu-sep { height: 0.5px; margin: 4px 6px; background: var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.dsh-rc-set-menu-item { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.dsh-rc-set-menu-item:hover, .dsh-rc-set-menu-item:focus-visible { outline: none; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dsh-rc-set-menu-item svg { flex: none; margin-top: 2px; }
.dsh-rc-set-menu-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.dsh-rc-set-menu-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-rc-set-menu-check { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--dsw-alias-state-business-primary, #3b5bdb); }
.dsh-rc-modal-backdrop { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,0.32); }
.dsh-rc-modal-card { display: flex; flex-direction: column; overflow: hidden; width: min(480px, 100%); max-height: min(88vh, 760px); border-radius: var(--dsw-radius-xl, 16px); background: var(--dsw-alias-bg-primary, #fff); color: var(--dsw-alias-label-primary, #111); box-shadow: var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,0.25)); }
.dsh-rc-modal-head { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 16px 16px 12px 20px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.dsh-rc-modal-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
.dsh-rc-modal-x { flex: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; }
.dsh-rc-modal-x:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dsh-rc-modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; font-size: 13px; line-height: 20px; }
.dsh-rc-modal-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 12px 20px 16px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.dsh-rc-modal-foot-spacer { flex: 1 1 auto; }
.dsh-rc-modal-btn { height: 32px; padding: 0 14px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3)); background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.dsh-rc-modal-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.dsh-rc-modal-btn[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-state-business-primary, #3b5bdb); color: #fff; }
.dsh-rc-modal-btn[data-primary="true"]:hover:not(:disabled) { filter: brightness(0.94); background: var(--dsw-alias-state-business-primary, #3b5bdb); }
.dsh-rc-modal-btn[data-danger="true"] { border-color: transparent; background: var(--dsw-alias-state-error-primary, #dc2626); color: #fff; }
.dsh-rc-modal-btn[data-danger="true"]:hover:not(:disabled) { filter: brightness(0.94); background: var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-rc-modal-btn[data-primary="true"]:active:not(:disabled), .dsh-rc-modal-btn[data-danger="true"]:active:not(:disabled) { filter: brightness(0.88); }
.dsh-rc-modal-btn:disabled { opacity: 0.6; cursor: default; }
.dsh-rc-modal-x:active { background: rgba(127,127,127,0.2); }
.dsh-rc-modal-btn:focus-visible, .dsh-rc-modal-x:focus-visible, .dsh-rc-modal-select:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-bg-primary, #fff), 0 0 0 4px var(--dsw-alias-state-business-primary, #3b5bdb); }
.dsh-rc-modal-lead { margin: 0; color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-rc-modal-field { display: flex; flex-direction: column; gap: 6px; }
.dsh-rc-modal-label { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-rc-modal-select { width: 100%; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 12px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.1)); color: inherit; font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer; }
.dsh-rc-modal-select:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16)); }
.dsh-rc-modal-select:disabled { cursor: default; opacity: 0.6; }
.dsh-rc-modal-select .dsh-rc-set-label { flex: 1 1 auto; }
.dsh-rc-modal-note { padding: 8px 12px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25)); background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.08)); color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; line-height: 18px; }
.dsh-rc-modal-note[data-tone="error"] { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239,68,68,0.1)); color: var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-rc-modal-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-label, #b45309); }
.dsh-rc-modal-note { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.dsh-rc-modal-note[hidden] { display: none; }
.dsh-rc-modal-note > span { flex: 1 1 220px; min-width: 0; }
.dsh-rc-set-update { height: 28px; padding: 0 12px; font-size: 12px; color: var(--dsw-alias-label-primary, inherit); }
`;

/* -------------------------------- menu -------------------------------- */

export interface ChoiceItem {
  label: string;
  hint?: string;
  title?: string;
  checked?: boolean;
  icon?: SVGSVGElement;
  run: () => void;
}

export type ChoiceEntry = ChoiceItem | { heading: string } | { separator: true };

let closeOpenMenu: (() => void) | undefined;
/** Open modals, newest last: Escape closes only the top one. */
const modalStack: Array<() => void> = [];

/** A choice menu under (or above) its trigger; closes on choice, outside press, scroll, blur or Escape. */
export function openChoiceMenu(anchor: HTMLElement, label: string, entries: ChoiceEntry[]): void {
  const reopen = anchor.getAttribute('aria-expanded') !== 'true';
  closeOpenMenu?.();
  if (!reopen) return;
  const menu = document.createElement('div');
  menu.className = 'dsh-rc-set-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  const close = (): void => {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (closeOpenMenu === close) closeOpenMenu = undefined;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    document.removeEventListener('scroll', onScroll, true);
  };
  const outside = (event: Event): void => {
    if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };
  const onScroll = (event: Event): void => { if (!menu.contains(event.target as Node)) close(); };
  const items: HTMLButtonElement[] = [];
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); anchor.focus(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  for (const entry of entries) {
    if ('heading' in entry) {
      const heading = document.createElement('div');
      heading.className = 'dsh-rc-set-menu-heading';
      heading.setAttribute('role', 'presentation');
      heading.textContent = entry.heading;
      menu.append(heading);
      continue;
    }
    if ('separator' in entry) {
      const sep = document.createElement('div');
      sep.className = 'dsh-rc-set-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.append(sep);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dsh-rc-set-menu-item';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', entry.checked === true ? 'true' : 'false');
    if (entry.title !== undefined) button.title = entry.title;
    if (entry.icon !== undefined) button.append(entry.icon);
    const text = document.createElement('span');
    text.className = 'dsh-rc-set-menu-text';
    const main = document.createElement('span');
    main.textContent = entry.label;
    text.append(main);
    if (entry.hint !== undefined && entry.hint !== '') {
      const hint = document.createElement('span');
      hint.className = 'dsh-rc-set-menu-hint';
      hint.textContent = entry.hint;
      text.append(hint);
    }
    button.append(text);
    const check = entry.checked === true ? icon('check', 16) : document.createElement('span');
    check.classList.add('dsh-rc-set-menu-check');
    button.append(check);
    button.addEventListener('click', (event) => { event.stopPropagation(); close(); entry.run(); });
    items.push(button);
    menu.append(button);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  const below = rect.bottom + 4 + height <= window.innerHeight - 8;
  menu.style.left = `${String(Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))))}px`;
  menu.style.top = `${String(Math.round(below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height)))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  closeOpenMenu = close;
  (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  document.addEventListener('scroll', onScroll, true);
}

/** Menu entries for the Permissions picker. */
export function permissionEntries(t: T, config: SessionConfig, current: string | null, pick: (value: string) => void): ChoiceEntry[] {
  const options = config.permissions?.options ?? [];
  return [
    { heading: t('settingsPermissions') },
    ...options.map((option): ChoiceItem => {
      const hint = permissionHint(t, option);
      return {
        label: permissionLabel(t, option, option.value),
        ...(hint === undefined ? {} : { hint }),
        checked: option.value === current,
        icon: icon(isFullAccess(option.value, config) ? 'shieldAlert' : 'shield', 16),
        run: () => pick(option.value),
      };
    }),
  ];
}

/** Menu entries for the model + effort picker: models by provider, then the chosen model's efforts. */
export function modelEntries(t: T, config: SessionConfig, current: ModelSelection | null, pick: (selection: ModelSelection) => void): ChoiceEntry[] {
  const entries: ChoiceEntry[] = [];
  const multiple = config.models.groups.length > 1;
  entries.push({ heading: t('settingsModel') });
  config.models.groups.forEach((group, index) => {
    if (multiple) {
      if (index > 0) entries.push({ separator: true });
      entries.push({ heading: group.name });
    }
    for (const model of group.models) {
      const split = splitModelBadge(model.name, model.id);
      entries.push({
        label: split.badge === '' ? model.name : `${split.name} ${split.badge}`,
        ...(model.description === undefined ? {} : { title: model.description }),
        checked: current?.provider === group.id && current.model === model.id,
        run: () => pick(withModel(model, group.id, current?.reasoningEffort)),
      });
    }
  });
  const chosen = findModel(config, current);
  if (chosen !== undefined && current !== null && chosen.efforts.length > 0) {
    const effort = current.reasoningEffort ?? chosen.defaultEffort;
    entries.push({ separator: true }, { heading: t('settingsEffort') });
    for (const option of chosen.efforts) {
      entries.push({
        label: option.name,
        ...(option.description === undefined ? {} : { hint: option.description }),
        checked: option.id === effort,
        run: () => pick({ provider: current.provider, model: current.model, reasoningEffort: option.id }),
      });
    }
  }
  return entries;
}

/** Fill a trigger button with the Permissions chip content. */
export function renderPermissionTrigger(button: HTMLButtonElement, t: T, config: SessionConfig, value: string | null): void {
  const option = config.permissions?.options.find((candidate) => candidate.value === value);
  const label = document.createElement('span');
  label.className = 'dsh-rc-set-label';
  label.textContent = permissionLabel(t, option, value);
  const chevron = icon('chevron', 14);
  chevron.classList.add('dsh-rc-set-chevron');
  const danger = isFullAccess(value, config);
  button.replaceChildren(icon(danger ? 'shieldAlert' : 'shield', 14), label, chevron);
  button.setAttribute('aria-haspopup', 'menu');
  button.title = t('settingsPermissions');
}

/** Fill a trigger button with the model + effort chip content. */
export function renderModelTrigger(button: HTMLButtonElement, t: T, config: SessionConfig, value: ModelSelection | null): void {
  const { model, effort } = modelLabel(config, value);
  const { name, badge } = splitModelBadge(model, value?.model ?? '');
  const label = document.createElement('span');
  label.className = 'dsh-rc-set-label';
  label.textContent = name === '' ? t('settingsModel') : name;
  const parts: Node[] = [label];
  if (badge !== '') {
    const pill = document.createElement('span');
    pill.className = 'dsh-rc-set-badge';
    pill.textContent = badge;
    parts.push(pill);
  }
  if (effort !== '') {
    const caption = document.createElement('span');
    caption.className = 'dsh-rc-set-effort';
    caption.textContent = effort;
    parts.push(caption);
  }
  const chevron = icon('chevron', 14);
  chevron.classList.add('dsh-rc-set-chevron');
  button.replaceChildren(...parts, chevron);
  button.setAttribute('aria-haspopup', 'menu');
  button.title = t('settingsModelAndEffort');
}

/* -------------------------------- modal ------------------------------- */

interface ModalParts {
  backdrop: HTMLDivElement;
  body: HTMLDivElement;
  foot: HTMLDivElement;
  close: () => void;
}

/**
 * The shared modal shell: fixed header (title, X at the far right), a body
 * that is the only scroll region, and a fixed footer (Close at the far left).
 */
function openModal(title: string, closeLabel: string, onClose: () => void): ModalParts {
  closeOpenMenu?.();
  const backdrop = document.createElement('div');
  backdrop.className = 'dsh-rc-modal-backdrop';
  const card = document.createElement('div');
  card.className = 'dsh-rc-modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const head = document.createElement('div');
  head.className = 'dsh-rc-modal-head';
  const heading = document.createElement('h2');
  heading.className = 'dsh-rc-modal-title';
  heading.id = `dsh-rc-modal-${String(Date.now())}`;
  heading.textContent = title;
  card.setAttribute('aria-labelledby', heading.id);
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dsh-rc-modal-x';
  x.setAttribute('aria-label', closeLabel);
  x.title = closeLabel;
  x.append(icon('x', 16));
  head.append(heading, x);
  const body = document.createElement('div');
  body.className = 'dsh-rc-modal-body';
  const foot = document.createElement('div');
  foot.className = 'dsh-rc-modal-foot';
  card.append(head, body, foot);
  backdrop.append(card);
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeOpenMenu?.();
    backdrop.remove();
    const at = modalStack.indexOf(close);
    if (at >= 0) modalStack.splice(at, 1);
    document.removeEventListener('keydown', onKey, true);
    previous?.focus?.();
    onClose();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || closeOpenMenu !== undefined || modalStack[modalStack.length - 1] !== close) return;
    event.stopImmediatePropagation();
    close();
  };
  x.addEventListener('click', close);
  backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  modalStack.push(close);
  document.body.append(backdrop);
  return { backdrop, body, foot, close };
}

function modalButton(label: string, kind: 'plain' | 'primary' | 'danger'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-rc-modal-btn';
  if (kind === 'primary') button.dataset['primary'] = 'true';
  if (kind === 'danger') button.dataset['danger'] = 'true';
  button.textContent = label;
  return button;
}

/** The same confirmation the local picker asks for before Full access. */
export function confirmFullAccess(t: T): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const modal = openModal(t('settingsFullAccessTitle'), t('settingsClose'), () => resolve(answer));
    const text = document.createElement('p');
    text.className = 'dsh-rc-modal-lead';
    text.textContent = t('settingsFullAccessBody');
    modal.body.append(text);
    const cancel = modalButton(t('settingsClose'), 'plain');
    const confirm = modalButton(t('settingsFullAccessConfirm'), 'danger');
    const spacer = document.createElement('span');
    spacer.className = 'dsh-rc-modal-foot-spacer';
    cancel.addEventListener('click', modal.close);
    confirm.addEventListener('click', () => { answer = true; modal.close(); });
    modal.foot.append(cancel, spacer, confirm);
    cancel.focus();
  });
}

export interface NewSessionChoice {
  workspaceId: string;
  model?: ModelSelection;
  permission?: string;
}

export interface NewSessionDialogOptions {
  t: T;
  deviceName: string;
  folders: Array<{ workspaceId: string; workspaceName: string }>;
  /** The folder to start on (e.g. the workspace whose + was pressed). */
  initialFolder?: string;
  /** Loads the computer's choices; a rejection or undefined means folder only. */
  loadConfig: () => Promise<SessionConfig | undefined>;
  status?: () => Promise<unknown>;
  update?: () => Promise<unknown>;
  create: (choice: NewSessionChoice) => Promise<void>;
}

/** New Remote Session: project folder, model and effort, and permissions, like a new local session. */
export function openNewSessionDialog(options: NewSessionDialogOptions): void {
  const { t } = options;
  const modal = openModal(t('settingsNewSessionTitle'), t('settingsClose'), () => undefined);
  const lead = document.createElement('p');
  lead.className = 'dsh-rc-modal-lead';
  lead.textContent = t('settingsNewSessionOn').replace('{name}', options.deviceName);
  modal.body.append(lead);

  const field = (labelText: string): { wrap: HTMLDivElement; button: HTMLButtonElement } => {
    const wrap = document.createElement('div');
    wrap.className = 'dsh-rc-modal-field';
    const label = document.createElement('span');
    label.className = 'dsh-rc-modal-label';
    label.textContent = labelText;
    label.id = `dsh-rc-f-${Math.random().toString(36).slice(2)}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dsh-rc-modal-select';
    button.setAttribute('aria-labelledby', label.id);
    wrap.append(label, button);
    return { wrap, button };
  };

  let folder = options.folders.some((row) => row.workspaceId === options.initialFolder)
    ? options.initialFolder ?? ''
    : options.folders[0]?.workspaceId ?? '';
  let config: SessionConfig | undefined;
  let model: ModelSelection | null = null;
  let permission: string | null = null;
  let busy = false;

  const folderField = field(t('settingsProjectFolder'));
  const renderFolder = (): void => {
    const row = options.folders.find((candidate) => candidate.workspaceId === folder);
    const label = document.createElement('span');
    label.className = 'dsh-rc-set-label';
    label.textContent = row?.workspaceName ?? folder;
    const chevron = icon('chevron', 16);
    chevron.classList.add('dsh-rc-set-chevron');
    folderField.button.replaceChildren(label, chevron);
    folderField.button.title = folder;
  };
  folderField.button.setAttribute('aria-haspopup', 'menu');
  folderField.button.addEventListener('click', () => openChoiceMenu(folderField.button, t('settingsProjectFolder'), [
    { heading: t('settingsProjectFolder') },
    ...options.folders.map((row): ChoiceItem => ({
      label: row.workspaceName,
      hint: row.workspaceId,
      checked: row.workspaceId === folder,
      run: () => { folder = row.workspaceId; renderFolder(); },
    })),
  ]));
  renderFolder();
  modal.body.append(folderField.wrap);

  const modelField = field(t('settingsModelAndEffort'));
  const permissionField = field(t('settingsPermissions'));
  const note = document.createElement('div');
  note.className = 'dsh-rc-modal-note';
  note.textContent = '…';
  modal.body.append(note);

  const renderSettings = (): void => {
    if (config === undefined) return;
    renderModelTrigger(modelField.button, t, config, model);
    modelField.button.disabled = config.models.groups.length === 0;
    if (config.permissions !== null) renderPermissionTrigger(permissionField.button, t, config, permission);
  };
  modelField.button.addEventListener('click', () => {
    if (config === undefined) return;
    openChoiceMenu(modelField.button, t('settingsModelAndEffort'), modelEntries(t, config, model, (next) => { model = next; renderSettings(); }));
  });
  permissionField.button.addEventListener('click', () => {
    if (config === undefined) return;
    openChoiceMenu(permissionField.button, t('settingsPermissions'), permissionEntries(t, config, permission, (next) => {
      if (!isFullAccess(next, config) || isFullAccess(permission, config)) { permission = next; renderSettings(); return; }
      void confirmFullAccess(t).then((yes) => { if (yes) { permission = next; renderSettings(); } });
    }));
  });

  const close = modalButton(t('settingsClose'), 'plain');
  const create = modalButton(t('settingsCreate'), 'primary');
  const spacer = document.createElement('span');
  spacer.className = 'dsh-rc-modal-foot-spacer';
  close.addEventListener('click', modal.close);
  create.disabled = folder === '';
  create.addEventListener('click', () => {
    if (busy || folder === '') return;
    busy = true;
    create.disabled = true;
    create.textContent = t('settingsCreating');
    const choice: NewSessionChoice = {
      workspaceId: folder,
      ...(config !== undefined && model !== null ? { model } : {}),
      ...(config?.permissions != null && permission !== null ? { permission } : {}),
    };
    options.create(choice).then(modal.close, (reason: unknown) => {
      busy = false;
      create.disabled = false;
      create.textContent = t('settingsCreate');
      note.hidden = false;
      note.dataset['tone'] = 'error';
      note.textContent = reason instanceof Error ? reason.message : String(reason);
    });
  });
  modal.foot.append(close, spacer, create);
  create.focus();

  let failure: unknown = new Error('HTTP 403');
  void options.loadConfig().catch((reason: unknown) => { failure = reason; return undefined; }).then((loaded) => {
    if (!modal.backdrop.isConnected) return;
    if (loaded === undefined) {
      note.textContent = t('settingsUnavailable');
      const { status, update } = options;
      if (status !== undefined && update !== undefined) void explainUnavailable(note, { t, deviceName: options.deviceName, reason: failure, status, update, isCurrent: () => modal.backdrop.isConnected });
      return;
    }
    config = loaded;
    const initial = initialChoices(loaded);
    model = initial.model;
    permission = initial.permission;
    note.remove();
    note.removeAttribute('data-tone');
    note.hidden = true;
    folderField.wrap.after(modelField.wrap);
    if (loaded.permissions !== null) modelField.wrap.after(permissionField.wrap);
    modal.body.append(note);
    if (loaded.models.groups.length === 0) {
      note.hidden = false;
      note.dataset['tone'] = 'warn';
      note.textContent = t('settingsNoModels');
    }
    renderSettings();
  });
}

/* ---------------------------- outdated host ---------------------------- */

/** True when a host refused the settings call because it predates it. */
export function isOutdatedError(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason);
  return /not available over the edge|answered HTTP 40[34]\b/i.test(text);
}

/**
 * Fill `note` with why the controls are missing: the host's version and its
 * own update status, plus an Update That Computer button. Plain DOM, no markup.
 */
export async function explainUnavailable(
  note: HTMLElement,
  options: { t: T; deviceName: string; reason: unknown; status: () => Promise<unknown>; update: () => Promise<unknown>; isCurrent?: () => boolean },
): Promise<void> {
  const current = options.isCurrent ?? ((): boolean => true);
  const { t, deviceName } = options;
  const fill = (name: string): string => name.replace('{name}', deviceName);
  note.replaceChildren();
  note.dataset['tone'] = 'warn';
  if (!isOutdatedError(options.reason)) {
    note.textContent = fill(t('settingsLoadFailed'));
    note.title = options.reason instanceof Error ? options.reason.message : String(options.reason);
    return;
  }
  let version = '';
  let updateMessage = '';
  try {
    const status = (await options.status()) as Record<string, unknown> | undefined;
    if (typeof status?.['version'] === 'string') version = status['version'];
    if (typeof status?.['updateMessage'] === 'string') updateMessage = status['updateMessage'];
  } catch { /* status is best effort */ }
  // A newer call (another session, or a reload) owns the note now.
  if (!current()) return;
  note.replaceChildren();
  const text = document.createElement('span');
  text.textContent = version === '' ? fill(t('settingsOutdatedUnknown')) : fill(t('settingsOutdated')).replace('{version}', version);
  if (updateMessage !== '') text.textContent += ` ${updateMessage}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-rc-modal-btn dsh-rc-set-update';
  button.textContent = t('settingsUpdateRemote');
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = t('settingsUpdating');
    options.update().then(
      () => { if (current()) { text.textContent = fill(t('settingsUpdateAsked')); button.remove(); } },
      (reason: unknown) => {
        button.disabled = false;
        button.textContent = t('settingsUpdateRemote');
        if (!current()) return;
        // A host older than this call cannot be updated from here, only by hand once.
        const detail = reason instanceof Error ? reason.message : String(reason);
        text.textContent = isOutdatedError(reason) ? fill(t('settingsUpdateByHand')) : /restart twice|still working/.test(detail) ? detail : fill(t('settingsUpdateFailed'));
        text.title = detail;
        if (isOutdatedError(reason)) button.remove();
      },
    );
  });
  note.append(text, button);
}
