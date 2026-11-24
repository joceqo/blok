import { afterEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddedServer, useEmbeddedServer } from './native-runtime';
import { initialWorkspace, type RemoteWorkspace } from './workspace-registry';

afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); localStorage.clear(); });

describe('embedded desktop server', () => {
  const remote: RemoteWorkspace = {kind:'remote', id:'one', accountId:'alice', name:'Project', workspaceId:'project', server:'http://127.0.0.1:51230', embedded:true};
  it('only starts the bundled runtime by default on a new native installation', async () => {
    const params = new URLSearchParams();
    expect(await useEmbeddedServer(params, initialWorkspace)).toBe(false);
    const invoke = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(null);
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    expect(await useEmbeddedServer(params, initialWorkspace)).toBe(true);
    invoke.mockResolvedValueOnce(true).mockResolvedValueOnce('{"pages":[]}');
    expect(await useEmbeddedServer(params, initialWorkspace)).toBe(false);
    invoke.mockClear();
    expect(await useEmbeddedServer(new URLSearchParams('local=1'), initialWorkspace)).toBe(false);
    expect(await useEmbeddedServer(params, {...remote, embedded:false})).toBe(false);
    expect(await useEmbeddedServer(params, remote)).toBe(true);
    expect(await useEmbeddedServer(new URLSearchParams('server=https://example.org'), remote)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('accepts only the local origin returned by the native supervisor', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(remote.server).mockResolvedValueOnce('https://example.org');
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    expect(await startEmbeddedServer()).toBe(remote.server);
    await expect(startEmbeddedServer()).rejects.toThrow('Adresse');
    expect(invoke).toHaveBeenCalledWith('ensure_embedded_server');
  });
});
