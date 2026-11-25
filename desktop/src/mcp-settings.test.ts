import { afterEach, expect, it, vi } from 'vitest';
import { mountMcpSettings } from './mcp-settings';
import type { CloudClient } from './cloud/client';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mount(request: (path: string, init?: RequestInit) => Promise<unknown>, origin = '') {
  const content = document.createElement('div');
  document.body.append(content);
  mountMcpSettings(content, { origin, request } as CloudClient);
  return {
    content,
    name: content.querySelector<HTMLInputElement>('[data-desktop-mcp-name]')!,
    secret: content.querySelector<HTMLElement>('[data-desktop-mcp-secret]')!,
    list: content.querySelector<HTMLElement>('[data-desktop-mcp-list]')!,
    status: content.querySelector<HTMLElement>('[role="status"]')!,
    click(label: string) {
      const button = [...content.querySelectorAll('button')].find(control => control.textContent === label);
      expect(button, label).toBeDefined();
      button!.click();
    },
  };
}

it('creates, copies, rotates and revokes a token, removing its revealed value immediately', async () => {
  let id = '';
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/mcp/tokens' && !init) return { tokens: id ? [{id, label:'Codex', expiresAt:'2027-02-10T00:00:00Z', lastUsedAt:null}] : [] };
    if (path === '/api/mcp/tokens' && init?.method === 'POST') { id = 'first'; return { id, token:'first-fixture' }; }
    if (path === '/api/mcp/tokens/first/rotate') { id = 'second'; return { id, token:'second-fixture' }; }
    if (path === '/api/mcp/tokens/second' && init?.method === 'DELETE') { id = ''; return { ok:true }; }
    throw new Error('unexpected request ' + path);
  });
  const ui = mount(request);
  await vi.waitFor(() => expect(ui.list.textContent).toContain('Aucun jeton'));
  ui.click('Copier l’URL');
  await vi.waitFor(() => expect(ui.status.textContent).toBe('Adresse copiée.'));
  expect(writeText).toHaveBeenCalledWith(location.origin + '/mcp');
  ui.name.value = ' Codex ';
  ui.click('Créer un jeton');
  await vi.waitFor(() => expect(ui.list.textContent).toContain('Jamais utilisé'));
  expect(request).toHaveBeenCalledWith('/api/mcp/tokens', {method:'POST',body:JSON.stringify({label:'Codex'})});
  expect(ui.list.textContent).not.toContain('first-fixture');
  ui.click('Copier le jeton');
  await vi.waitFor(() => expect(ui.status.textContent).toBe('Jeton copié.'));
  expect(writeText).toHaveBeenLastCalledWith('first-fixture');
  ui.click('Renouveler');
  await vi.waitFor(() => expect(ui.secret.textContent).toContain('second-fixture'));
  expect(ui.secret.textContent).not.toContain('first-fixture');
  ui.click('Révoquer');
  await vi.waitFor(() => expect(ui.list.textContent).toContain('Aucun jeton'));
  expect(ui.secret.hidden).toBe(true);
  expect(ui.content.textContent).not.toContain('second-fixture');
});

it('selects the full URL for manual copying when the clipboard is unavailable', async () => {
  vi.stubGlobal('navigator', {});
  const ui = mount(async () => ({tokens: []}), 'https://cloud.example.test');
  ui.click('Copier l’URL');
  await vi.waitFor(() => expect(ui.status.textContent).toContain('Copie automatique indisponible'));
  expect(window.getSelection()?.toString()).toBe('https://cloud.example.test/mcp');
});

it('keeps a revealed token on a failed second creation and supports dismissing the secret', async () => {
  let posts = 0;
  const ui = mount(async (_path, init) => {
    if (!init) return { tokens: [] };
    if (++posts === 1) return { id:'first', token:'first-fixture' };
    throw new Error('simulated failure');
  });
  ui.name.value = 'Premier';
  ui.click('Créer un jeton');
  await vi.waitFor(() => expect(ui.secret.textContent).toContain('first-fixture'));
  ui.name.value = 'Suivant';
  ui.click('Créer un jeton');
  await vi.waitFor(() => expect(ui.status.textContent).toContain('Impossible de créer'));
  expect(ui.name.value).toBe('Suivant');
  expect(ui.secret.textContent).toContain('first-fixture');
  ui.click('Masquer le jeton');
  expect(ui.secret.hidden).toBe(true);
  expect(ui.secret.textContent).toBe('');
  expect(document.activeElement).toBe(ui.name);
});

it('retries listing and protects against duplicate submissions while creation is in flight', async () => {
  let gets = 0;
  let finishCreation!: (result: {id:string; token:string}) => void;
  const issued = new Promise<{id:string; token:string}>((resolve) => { finishCreation = resolve; });
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init) return issued;
    if (++gets === 1) throw new Error('offline');
    return {tokens: []};
  });
  const ui = mount(request);
  await vi.waitFor(() => expect(ui.list.textContent).toContain('Réessayer'));
  ui.click('Réessayer');
  await vi.waitFor(() => expect(ui.list.textContent).toContain('Aucun jeton'));
  ui.name.value = 'Nom';
  ui.click('Créer un jeton');
  ui.content.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable:true}));
  expect(request.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(1);
  finishCreation({id:'first',token:'first-fixture'});
  await vi.waitFor(() => expect(ui.status.textContent).toBe('Jeton créé.'));
});
