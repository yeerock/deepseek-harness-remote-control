import { describe, expect, it, vi } from 'vitest';
import { dispatchEndpoint, isPeerEndpoint, type SharingRpcTarget } from '../src/host.js';
import {
  normalizeModelCatalog,
  normalizePermissionCatalog,
  sessionSettingsOf,
  validatePermission,
  validateSelection,
} from '../src/session-config.js';

/** Shape of the Harness `session/modelCatalog` answer. */
const rawCatalog = {
  default: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' },
  routableProviders: ['deepseek-account'],
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'Thinks longer' }], defaultEffort: 'low' } },
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'bad id with spaces', name: 'dropped' },
      ],
    },
    { id: 'empty', name: 'Empty', models: [] },
  ],
  failures: [],
};

const rawPresets = {
  options: [
    { value: 'read-only', name: 'Read Only' },
    { value: 'workspace-write', name: 'Workspace Write', description: 'Edits in the workspace' },
    { value: 'danger-full-access', name: 'Full access' },
    { value: 'custom', name: 'Custom' },
  ],
  defaultOptions: [],
  defaultPreset: 'workspace-write',
};

describe('session settings catalogs', () => {
  it('keeps listed models and efforts, drops malformed ids and empty providers', () => {
    const models = normalizeModelCatalog(rawCatalog);
    expect(models.default).toEqual({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' });
    expect(models.groups).toHaveLength(1);
    expect(models.groups[0]?.models.map((m) => m.id)).toEqual(['deepseek-v4.1-flash', 'deepseek-chat']);
    expect(models.groups[0]?.models[0]).toMatchObject({ defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'Thinks longer' }] });
    expect(models.groups[0]?.models[1]?.efforts).toEqual([]);
  });

  it('survives garbage from the Harness', () => {
    expect(normalizeModelCatalog(undefined)).toEqual({ groups: [], default: null });
    expect(normalizeModelCatalog({ groups: 'x', default: 5 })).toEqual({ groups: [], default: null });
    expect(normalizePermissionCatalog(undefined)).toBeNull();
    expect(normalizePermissionCatalog({ options: [{ value: 'custom', name: 'Custom' }] })).toBeNull();
  });

  it('never offers the display-only custom preset', () => {
    const permissions = normalizePermissionCatalog(rawPresets);
    expect(permissions?.options.map((o) => o.value)).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
    expect(permissions?.defaultPreset).toBe('workspace-write');
    expect(permissions?.options.map((o) => o.dangerous)).toEqual([false, false, true]);
  });

  it('flags a full-access preset by the host flag, whatever it is called', () => {
    const permissions = normalizePermissionCatalog({ options: [{ value: 'yolo', name: 'Yolo', dangerous: true }, { value: 'safe', name: 'Safe', dangerous: false }] });
    expect(permissions?.options.map((o) => [o.value, o.dangerous])).toEqual([['yolo', true], ['safe', false]]);
  });

  it('accepts only a listed model, and only an effort that model offers', () => {
    const models = normalizeModelCatalog(rawCatalog);
    expect(validateSelection(models, { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' })).toEqual({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' });
    expect(validateSelection(models, { provider: 'deepseek-account', model: 'deepseek-chat' })).toEqual({ provider: 'deepseek-account', model: 'deepseek-chat' });
    expect(validateSelection(models, { provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'high' })).toBe('That effort is not available for this model.');
    expect(validateSelection(models, { provider: 'evil', model: 'deepseek-chat' })).toBe('That model is not available on this computer.');
    expect(validateSelection(models, { provider: 'deepseek-account', model: '../../etc' })).toBe('That model is not available on this computer.');
    expect(validateSelection(models, 'deepseek-chat')).toBe('Choose a model.');
  });

  it('accepts only a listed preset', () => {
    const permissions = normalizePermissionCatalog(rawPresets);
    expect(validatePermission(permissions, 'danger-full-access')).toBe('danger-full-access');
    expect(validatePermission(permissions, 'custom')).toEqual({ error: 'That permission mode is not available on this computer.' });
    expect(validatePermission(permissions, 'workspace-write; rm -rf /')).toMatchObject({ error: expect.any(String) });
    expect(validatePermission(permissions, 'read-only\n/x')).toMatchObject({ error: expect.any(String) });
    expect(validatePermission(permissions, 5)).toMatchObject({ error: expect.any(String) });
    expect(validatePermission(null, 'read-only')).toMatchObject({ error: expect.any(String) });
  });

  it('reads the next-request model and the current preset from session projections', () => {
    expect(sessionSettingsOf({
      asOfSeq: 9,
      values: {
        modelSelection: { lastUsed: { provider: 'p', model: 'a' }, next: { provider: 'p', model: 'b', reasoningEffort: 'high' } },
        permissions: { currentValue: 'danger-full-access' },
      },
    })).toEqual({ model: { provider: 'p', model: 'b', reasoningEffort: 'high' }, permission: 'danger-full-access' });
    expect(sessionSettingsOf({ values: { modelSelection: { lastUsed: { provider: 'p', model: 'a' }, next: null } } })).toEqual({ model: { provider: 'p', model: 'a' }, permission: null });
    expect(sessionSettingsOf(undefined)).toEqual({ model: null, permission: null });
  });
});

describe('session settings endpoints', () => {
  it('are peer endpoints on the serving computer, and local relays on the asking one', () => {
    for (const ok of ['remote.config', 'remote.selectModel', 'remote.setPermission']) expect(isPeerEndpoint(ok), ok).toBe(true);
    for (const no of ['session.config', 'session.selectModel', 'session.setPermission']) expect(isPeerEndpoint(no), no).toBe(false);
  });

  it('relay to the peer without the deviceId', async () => {
    const peerCall = vi.fn(async () => ({ ok: true }));
    const target = { peerCall } as unknown as SharingRpcTarget;
    await dispatchEndpoint(target, 'session.selectModel', { deviceId: 'dev_x', sessionId: 's1', selection: { provider: 'p', model: 'm' } });
    expect(peerCall).toHaveBeenCalledWith('dev_x', 'remote.selectModel', { sessionId: 's1', selection: { provider: 'p', model: 'm' } });
    await dispatchEndpoint(target, 'session.setPermission', { deviceId: 'dev_x', sessionId: 's1', permission: 'read-only' });
    expect(peerCall).toHaveBeenLastCalledWith('dev_x', 'remote.setPermission', { sessionId: 's1', permission: 'read-only' });
    await dispatchEndpoint(target, 'session.config', { deviceId: 'dev_x' });
    expect(peerCall).toHaveBeenLastCalledWith('dev_x', 'remote.config', {});
  });

  it('reject malformed session ids before reaching the Harness', async () => {
    const localConfig = vi.fn();
    const localSelectModel = vi.fn();
    const localSetPermission = vi.fn();
    const target = { localConfig, localSelectModel, localSetPermission } as unknown as SharingRpcTarget;
    await expect(dispatchEndpoint(target, 'remote.config', { sessionId: '../x' })).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } });
    await expect(dispatchEndpoint(target, 'remote.selectModel', { sessionId: 5 })).resolves.toMatchObject({ ok: false });
    await expect(dispatchEndpoint(target, 'remote.setPermission', {})).resolves.toMatchObject({ ok: false });
    expect(localConfig).not.toHaveBeenCalled();
    expect(localSelectModel).not.toHaveBeenCalled();
    expect(localSetPermission).not.toHaveBeenCalled();
  });

  it('caps an oversized catalog', () => {
    const models = normalizeModelCatalog({ groups: [{ id: 'p', name: 'P', models: Array.from({ length: 500 }, (_, i) => ({ id: `m${String(i)}`, name: `M${String(i)}` })) }] });
    expect(models.groups[0]?.models).toHaveLength(200);
  });

  it('pass model and permission through remote.create', async () => {
    const localCreate = vi.fn(async () => ({ sessionId: 's2', warnings: [] }));
    const target = { localCreate } as unknown as SharingRpcTarget;
    await dispatchEndpoint(target, 'remote.create', { workspaceId: '/w/a', model: { provider: 'p', model: 'm' }, permission: 'read-only' });
    expect(localCreate).toHaveBeenCalledWith('/w/a', { model: { provider: 'p', model: 'm' }, permission: 'read-only' });
    await dispatchEndpoint(target, 'remote.create', { workspaceId: '/w/a' });
    expect(localCreate).toHaveBeenLastCalledWith('/w/a', {});
  });
});
