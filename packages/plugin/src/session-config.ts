/**
 * Session settings a peer can read and change on this computer's sessions:
 * model, reasoning effort and permission preset, the same three controls the
 * local composer offers.
 *
 * Every value a peer sends is checked against this Harness's own catalogs
 * before it reaches the Harness, so a peer can only pick what the local
 * pickers would offer. The Harness validates again on its side.
 */

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface EffortOption {
  id: string;
  name: string;
  description?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  efforts: EffortOption[];
  defaultEffort?: string;
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelOption[];
}

export interface PermissionOption {
  value: string;
  name: string;
  description?: string;
  /** True when the preset runs without the sandbox (full access); the client confirms before choosing it. */
  dangerous: boolean;
}

/** What a peer's pickers need: the choices, and the session's current values. */
export interface SessionConfig {
  models: { groups: ModelGroup[]; default: ModelSelection | null };
  permissions: { options: PermissionOption[]; defaultPreset: string | null } | null;
  /** Present when a session was named: its next-request model and current preset. */
  session?: { model: ModelSelection | null; permission: string | null };
}

const MAX_GROUPS = 32;
const MAX_MODELS = 200;
const MAX_EFFORTS = 16;
const MAX_TEXT = 300;
const ID_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

/** A model selection from Harness data or a peer, or undefined when malformed. */
export function selectionOf(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  const provider = id(value['provider']);
  const model = id(value['model']);
  if (provider === undefined || model === undefined) return undefined;
  const effort = value['reasoningEffort'];
  if (effort === undefined || effort === null || effort === '') return { provider, model };
  const reasoningEffort = id(effort);
  return reasoningEffort === undefined ? undefined : { provider, model, reasoningEffort };
}

/** Reduce the Harness model catalog (`session/modelCatalog`) to the picker shape. */
export function normalizeModelCatalog(raw: unknown): SessionConfig['models'] {
  const groups: ModelGroup[] = [];
  const rawGroups = isRecord(raw) && Array.isArray(raw['groups']) ? raw['groups'] : [];
  for (const group of rawGroups.slice(0, MAX_GROUPS)) {
    if (!isRecord(group)) continue;
    const groupId = id(group['id']);
    if (groupId === undefined) continue;
    const models: ModelOption[] = [];
    for (const model of (Array.isArray(group['models']) ? group['models'] : []).slice(0, MAX_MODELS)) {
      if (!isRecord(model)) continue;
      const modelId = id(model['id']);
      if (modelId === undefined) continue;
      const reasoning = isRecord(model['reasoning']) ? model['reasoning'] : undefined;
      const efforts: EffortOption[] = [];
      for (const effort of (Array.isArray(reasoning?.['efforts']) ? reasoning['efforts'] as unknown[] : []).slice(0, MAX_EFFORTS)) {
        if (!isRecord(effort)) continue;
        const effortId = id(effort['id']);
        if (effortId === undefined) continue;
        const description = text(effort['description']);
        efforts.push({ id: effortId, name: text(effort['name'], 60) ?? effortId, ...(description === undefined ? {} : { description }) });
      }
      const description = text(model['description']);
      const defaultEffort = id(reasoning?.['defaultEffort']);
      models.push({
        id: modelId,
        name: text(model['name'], 120) ?? modelId,
        ...(description === undefined ? {} : { description }),
        efforts,
        ...(defaultEffort !== undefined && efforts.some((effort) => effort.id === defaultEffort) ? { defaultEffort } : {}),
      });
    }
    if (models.length > 0) groups.push({ id: groupId, name: text(group['name'], 120) ?? groupId, models });
  }
  const fallback = isRecord(raw) ? selectionOf(raw['default']) : undefined;
  return { groups, default: fallback ?? null };
}

/** Reduce the Harness permission catalog (`permissionPresets/catalog`) to the picker shape. */
export function normalizePermissionCatalog(raw: unknown): SessionConfig['permissions'] {
  if (!isRecord(raw) || !Array.isArray(raw['options'])) return null;
  const options: PermissionOption[] = [];
  for (const option of raw['options'].slice(0, 32)) {
    if (!isRecord(option)) continue;
    const value = id(option['value']);
    // `custom` is display-only in the Harness: it can label the current state but is never selectable.
    if (value === undefined || value === 'custom') continue;
    const description = text(option['description']);
    const dangerous = option['dangerous'] === true || value === 'danger-full-access' || value === 'auto';
    options.push({ value, name: text(option['name'], 60) ?? value, ...(description === undefined ? {} : { description }), dangerous });
  }
  if (options.length === 0) return null;
  const defaultPreset = id(raw['defaultPreset']);
  return { options, defaultPreset: defaultPreset !== undefined && options.some((option) => option.value === defaultPreset) ? defaultPreset : null };
}

/**
 * Check a requested selection against the catalog: the provider and model
 * must be listed, and an effort must be one that model offers.
 * @returns the selection to send to the Harness, or an error message.
 */
export function validateSelection(models: SessionConfig['models'], requested: unknown): ModelSelection | string {
  const selection = selectionOf(requested);
  if (selection === undefined) return 'Choose a model.';
  const model = models.groups.find((group) => group.id === selection.provider)?.models.find((candidate) => candidate.id === selection.model);
  if (model === undefined) return 'That model is not available on this computer.';
  if (selection.reasoningEffort === undefined) return selection;
  if (!model.efforts.some((effort) => effort.id === selection.reasoningEffort)) return 'That effort is not available for this model.';
  return selection;
}

/** Check a requested preset against the permission catalog. */
export function validatePermission(permissions: SessionConfig['permissions'], requested: unknown): string | { error: string } {
  if (permissions === null) return { error: 'This computer does not offer permission presets.' };
  const value = typeof requested === 'string' ? requested : '';
  if (!permissions.options.some((option) => option.value === value)) return { error: 'That permission mode is not available on this computer.' };
  return value;
}

/** The session's next-request model and current preset from its Harness projections. */
export function sessionSettingsOf(projections: unknown): { model: ModelSelection | null; permission: string | null } {
  const values = isRecord(projections) && isRecord(projections['values']) ? projections['values'] : {};
  const selection = isRecord(values['modelSelection']) ? values['modelSelection'] : {};
  const model = selectionOf(selection['next']) ?? selectionOf(selection['lastUsed']) ?? null;
  const permissions = isRecord(values['permissions']) ? values['permissions'] : {};
  const permission = id(permissions['currentValue']) ?? null;
  return { model, permission };
}
