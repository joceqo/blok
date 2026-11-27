import { describe, expect, it } from 'vitest';
import { portableValue, restoredValue } from '../runtime/backup/references';
describe('portable workspace references', () => {
  it('keeps text and external URLs, remaps page links and removes local media tickets', () => {
    const name = 'a'.repeat(32) + '.png',
      origin = 'http://127.0.0.1:1111';
    const before = {
      text: 'page-1',
      pageId: 'page-1',
      url: origin + '/files/' + name + '?ticket=secret',
      href: 'https://example.org/page-1',
    };
    const portable = portableValue(before, origin, new Set([name]));
    expect(JSON.stringify(portable)).not.toContain('secret');
    expect(
      restoredValue(
        portable,
        new Map([['page-1', 'page-2']]),
        new Map([[name, 'b.png']]),
        'w',
        'w2',
        'http://127.0.0.1:2222',
      ),
    ).toEqual({ ...before, pageId: 'page-2', url: 'http://127.0.0.1:2222/files/b.png' });
  });
});

import { vi } from 'vitest';
import { mountWorkspaceBackup } from './workspace-backup';
import type { RemoteWorkspace } from './workspace-registry';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./native-runtime', () => ({ nativeBridge: () => bridge, deviceWorkspaces: vi.fn() }));
it('flushes the active space, offers three destinations and reports a completed folder backup', async () => {
  const ref = {
    kind: 'remote',
    embedded: true,
    device: true,
    id: 'space',
    name: 'Atelier',
  } as RemoteWorkspace;
  const flush = vi.fn().mockResolvedValue(undefined);
  bridge.invoke.mockResolvedValue({ location: '/Volumes/Backup/Atelier' });
  const panel = mountWorkspaceBackup(document.body, ref, flush);
  const form = document.querySelector<HTMLFormElement>('.workspace-backup-form')!;
  const destination = form.querySelector<HTMLButtonElement>('[data-backup-destination]')!;
  destination.click();
  expect([...document.querySelectorAll<HTMLElement>('[data-desktop-choice-popover] [role=menuitemradio]')].map(o => o.dataset.blokItemName)).toEqual([
    'folder',
    'git',
    's3',
  ]);
  document.querySelector<HTMLElement>('[data-blok-item-name=folder]')!.click();
  form.requestSubmit();
  await vi.waitFor(() => expect(form.textContent).toContain('/Volumes/Backup/Atelier'));
  expect(flush).toHaveBeenCalledOnce();
  expect(bridge.invoke).toHaveBeenCalledWith('embedded_workspace_backup', {
    options: expect.objectContaining({ kind: 'folder', action: 'save', workspace: 'space' }),
  });
  panel.destroy();
  form.remove();
});
