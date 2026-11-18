import { afterEach, expect, it, vi } from 'vitest';
import { mountMcpSettings } from './mcp-settings';
import type { CloudClient } from './cloud/client';

afterEach(() => { document.body.replaceChildren(); });

it('creates, rotates and revokes a personal MCP token without listing its secret', async () => {
  let id = '';
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/mcp/tokens' && !init) return {tokens: id ? [{id, label:'Codex', expiresAt:'2027-02-10T00:00:00Z'}] : []};
    if (path === '/api/mcp/tokens' && init?.method === 'POST') { id = 'first'; return {token:'first-secret'}; }
    if (path === '/api/mcp/tokens/first/rotate') { id = 'second'; return {token:'second-secret'}; }
    if (path === '/api/mcp/tokens/second' && init?.method === 'DELETE') { id = ''; return {ok:true}; }
    throw new Error(`unexpected request ${path}`);
  });
  const content = document.createElement('div'); document.body.append(content);
  mountMcpSettings(content, {origin:'https://cloud.example.test',request} as unknown as CloudClient);
  await vi.waitFor(() => expect(content.querySelector('[data-desktop-mcp-list]')?.textContent).toContain('Aucun jeton'));
  content.querySelector<HTMLInputElement>('[data-desktop-mcp-name]')!.value = 'Codex';
  [...content.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Créer un jeton')!.click();
  await vi.waitFor(() => expect(content.querySelector('[data-desktop-mcp-secret]')?.textContent).toContain('first-secret'));
  expect(content.querySelector('[data-desktop-mcp-list]')?.textContent).not.toContain('first-secret');
  [...content.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Renouveler')!.click();
  await vi.waitFor(() => expect(content.querySelector('[data-desktop-mcp-secret]')?.textContent).toContain('second-secret'));
  expect(content.querySelector('[data-desktop-mcp-secret]')?.textContent).not.toContain('first-secret');
  [...content.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Révoquer')!.click();
  await vi.waitFor(() => expect(content.querySelector('[data-desktop-mcp-list]')?.textContent).toContain('Aucun jeton'));
  expect(request).toHaveBeenCalledWith('/api/mcp/tokens/first/rotate', {method:'POST'});
});

it('sends the chosen lifetime, and offers a token that never expires', async () => {
  let sent: unknown = null;
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/mcp/tokens' && !init) return {tokens: []};
    if (path === '/api/mcp/tokens' && init?.method === 'POST') { sent = JSON.parse(String(init.body)); return {token:'secret'}; }
    throw new Error(`unexpected request ${path}`);
  });
  const content = document.createElement('div'); document.body.append(content);
  mountMcpSettings(content, {origin:'https://cloud.example.test',request} as unknown as CloudClient);
  await vi.waitFor(() => expect(content.querySelector('[data-desktop-mcp-lifetime]')).not.toBeNull());

  const lifetime = content.querySelector<HTMLSelectElement>('[data-desktop-mcp-lifetime]')!;
  expect([...lifetime.options].map(option => option.value)).toEqual(['1d','7d','30d','90d','1y','never']);
  // 90 days stays the default, so an existing habit keeps its current meaning.
  expect(lifetime.value).toBe('90d');

  lifetime.value = 'never';
  content.querySelector<HTMLInputElement>('[data-desktop-mcp-name]')!.value = 'Codex';
  [...content.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Créer un jeton')!.click();
  await vi.waitFor(() => expect(content.querySelector('[data-desktop-mcp-secret]')?.textContent).toContain('secret'));
  expect(sent).toEqual({label:'Codex', expiresIn:'never'});
});

it('says a token never expires instead of printing a date a century away', async () => {
  const far = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/mcp/tokens' && !init) return {tokens: [{id:'t', label:'Codex', expiresAt: far}]};
    throw new Error(`unexpected request ${path}`);
  });
  const content = document.createElement('div'); document.body.append(content);
  mountMcpSettings(content, {origin:'https://cloud.example.test',request} as unknown as CloudClient);
  await vi.waitFor(() => expect(content.querySelector('[data-desktop-mcp-list]')?.textContent).toContain('Codex'));
  const listed = content.querySelector('[data-desktop-mcp-list]')!.textContent ?? '';

  expect(listed).toContain('N’expire pas');
  expect(listed).not.toMatch(/21\d\d/);
});
