import { describe, expect, it, vi } from 'vitest';
import { dispatchEndpoint, projectFolders, registryWorkspaces, type SharingRpcTarget } from '../src/host.js';

class Entity {
  constructor(private readonly record: { path: string; title: string }) {}
  get path(): string { return this.record.path; }
  get title(): string { return this.record.title; }
}

describe('remote project folders', () => {
  it('reads the workspace registry in its own order, through class getters', () => {
    const ctx = { get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [new Entity({ path: '/w/xserva.com', title: 'xserva.com' }), new Entity({ path: 'C:\\Users\\admin\\empty', title: '' })] } : undefined) };
    expect(registryWorkspaces(ctx as never)).toEqual([
      { workspaceId: '/w/xserva.com', workspaceName: 'xserva.com' },
      { workspaceId: 'C:\\Users\\admin\\empty', workspaceName: 'empty' },
    ]);
  });

  it('returns nothing rather than throwing when the registry is missing or broken', () => {
    expect(registryWorkspaces({ get: () => undefined } as never)).toEqual([]);
    expect(registryWorkspaces({ get: () => ({ list: () => { throw new Error('boom'); } }) } as never)).toEqual([]);
  });

  it('lists registry folders first (empty ones included), then folders known only from sessions, without duplicates', () => {
    const folders = projectFolders(
      [{ workspaceId: '/w/a', workspaceName: 'a' }, { workspaceId: '/w/empty', workspaceName: 'empty' }],
      [{ workspaceId: '/w/b', workspaceName: 'b' }, { workspaceId: '/w/a', workspaceName: 'a' }, { workspaceId: '', workspaceName: 'x' }],
    );
    expect(folders.map((f) => f.workspaceId)).toEqual(['/w/a', '/w/empty', '/w/b']);
  });

  it('routes the chooser through the peer, and answers a peer with this computer\'s folders', async () => {
    const peerCall = vi.fn(async () => ({ workspaces: [{ workspaceId: '/w/a', workspaceName: 'a' }] }));
    const remoteWorkspaces = vi.fn(async () => ({ workspaces: [{ workspaceId: '/w/local', workspaceName: 'local' }] }));
    const target = { peerCall, remoteWorkspaces } as unknown as SharingRpcTarget;
    await expect(dispatchEndpoint(target, 'session.workspaces', { deviceId: 'dev_x' })).resolves.toEqual({ ok: true, value: { workspaces: [{ workspaceId: '/w/a', workspaceName: 'a' }] } });
    expect(peerCall).toHaveBeenCalledWith('dev_x', 'remote.workspaces', {});
    await expect(dispatchEndpoint(target, 'remote.workspaces', {})).resolves.toEqual({ ok: true, value: { workspaces: [{ workspaceId: '/w/local', workspaceName: 'local' }] } });
    await expect(dispatchEndpoint(target, 'session.workspaces', {})).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } });
  });
});

describe('what another computer may call', () => {
  it('allows the folder list and session calls, never local-only control', async () => {
    const { isPeerEndpoint } = await import('../src/host.js');
    for (const ok of ['remote.workspaces', 'remote.list', 'remote.create', 'status']) expect(isPeerEndpoint(ok), ok).toBe(true);
    for (const no of ['session.workspaces', 'session.create', 'update.check', 'update.restart', 'sharing.set', 'host.set', 'stop', undefined]) expect(isPeerEndpoint(no), String(no)).toBe(false);
  });
});
