import { afterEach, expect, it, vi } from 'vitest';
import { must } from '../test-helpers';
import type { RemoteWorkspace } from '../workspace-registry';
import { openTeamspaces } from './teamspaces';

const ref: RemoteWorkspace = { kind: 'remote', id: 'w', workspaceId: 'équipe', accountId: 'me', name: 'Atelier', role: 'member', server: 'https://example.test' };
const base = ref.server + '/api/workspaces/%C3%A9quipe/teamspaces';
const team = { id: 'A', name: 'Alpha' };
const bob = { userId: 'go_bob', email: 'bob@example.test' };
const response = (value: unknown) => Response.json(value);
const button = (name: string) => [...document.querySelectorAll('button')].find((node) =>
  node.getAttribute('aria-label') === name || node.textContent?.trim() === name);
const click = (name: string) => must(button(name), name).click();
const has = (text: string) => vi.waitFor(() => expect(document.body.textContent).toContain(text));
const name = (value: string) => {
  const input = must(document.querySelector<HTMLInputElement>('form input'));
  input.value = value; input.dispatchEvent(new Event('input'));
};
afterEach(() => { button('Fermer')?.click(); document.body.replaceChildren(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

it('lets viewers see the team and roster without member-directory or mutation controls', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({teamspaces: [team]})).mockResolvedValueOnce(response({members: [bob]}));
  vi.stubGlobal('fetch', fetch);
  openTeamspaces({ ...ref, role: 'viewer' });
  await has(bob.email);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([base, base + '/A/members']);
  expect(button('Alpha')?.getAttribute('aria-current')).toBe('true');
  for (const label of ['Nouvel espace d’équipe', 'Renommer', 'Supprimer', 'Retirer', 'Ajouter un membre']) expect(button(label)).toBeUndefined();
});

it('keeps the currently selected roster when an older request resolves last', async () => {
  let resolveFirst!: (result: Response) => void;
  const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const fetch = vi.fn().mockResolvedValueOnce(response({teamspaces: [team, {id: 'B', name: 'Beta'}]}))
    .mockReturnValueOnce(first).mockResolvedValueOnce(response({members: [bob]}));
  vi.stubGlobal('fetch', fetch); openTeamspaces(ref);
  await has('Beta'); click('Beta'); await has(bob.email);
  resolveFirst(response({members: [{userId: 'a', email: 'stale@example.test'}]}));
  await first; await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector('h3')?.textContent).toBe('Beta');
  expect(document.body.textContent).not.toContain('stale@example.test');
});

it('creates and renames an empty team, and deletes only after confirmation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({teamspaces: []}))
    .mockResolvedValueOnce(response({teamspace: team})).mockResolvedValueOnce(response({members: []}))
    .mockResolvedValueOnce(response({teamspace: {...team, name: 'Beta'}})).mockResolvedValueOnce(response({members: []}))
    .mockResolvedValueOnce(response({ok: true})).mockResolvedValueOnce(response({teamspaces: []}));
  vi.stubGlobal('fetch', fetch); openTeamspaces(ref);
  await has('Aucun espace d’équipe'); click('Nouvel espace d’équipe');
  expect(button('Créer')?.disabled).toBe(true); name('  Alpha  '); click('Créer');
  await has('Aucun membre dans cette équipe'); click('Renommer'); name('Beta'); click('Enregistrer');
  await has('Aucun membre dans cette équipe');
  expect(document.querySelector('h3')?.textContent).toBe('Beta');
  click('Supprimer'); expect(fetch).toHaveBeenCalledTimes(5); click('Confirmer la suppression');
  await has('Aucun espace d’équipe');
  expect(fetch.mock.calls[1]).toMatchObject([base, {method: 'POST', body: '{"name":"Alpha"}'}]);
  expect(fetch.mock.calls[3]).toMatchObject([base + '/A', {method: 'PATCH', body: '{"name":"Beta"}'}]);
  expect(fetch.mock.calls[5]).toMatchObject([base + '/A', {method: 'DELETE'}]);
});

it('uses the workspace directory, adds an existing user by their opaque ID, and removes only that team membership', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({teamspaces: [team]})).mockResolvedValueOnce(response({members: []}))
    .mockResolvedValueOnce(response({members: [{id: bob.userId, email: bob.email}]}))
    .mockResolvedValueOnce(response({member: bob})).mockResolvedValueOnce(response({ok: true}));
  vi.stubGlobal('fetch', fetch); openTeamspaces(ref);
  await has('Aucun membre dans cette équipe'); click('Ajouter un membre');
  await has('Rechercher un membre'); click('Choisir une personne');
  must([...document.querySelectorAll<HTMLElement>('[data-blok-testid="popover-item-title"]')].find((item) => item.textContent === bob.email)).click();
  click('Ajouter'); await has('Membres (1)'); click('Retirer ' + bob.email + ' de l’équipe'); await has('Membres (0)');
  expect(fetch.mock.calls[2]![0]).toBe(base.replace('/teamspaces', '/members'));
  expect(fetch.mock.calls[3]).toMatchObject([base + '/A/members', {method: 'POST', body: '{"userId":"go_bob"}'}]);
  expect(fetch.mock.calls[4]).toMatchObject([base + '/A/members/go_bob', {method: 'DELETE'}]);
});

it('keeps the form on a refusal and rechecks the role when refreshing', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({teamspaces: [team]})).mockResolvedValueOnce(response({members: []}))
    .mockResolvedValueOnce(Response.json({error: 'forbidden'}, {status: 403}))
    .mockResolvedValueOnce(response({role: 'viewer'}))
    .mockResolvedValueOnce(response({teamspaces: [team]})).mockResolvedValueOnce(response({members: [bob]}));
  vi.stubGlobal('fetch', fetch); openTeamspaces(ref); await has('Aucun membre dans cette équipe');
  click('Renommer'); name('Proposition'); click('Enregistrer'); await has('Vos droits ne permettent plus cette action');
  expect(document.querySelector<HTMLInputElement>('form input')?.value).toBe('Proposition');
  click('Actualiser'); await has(bob.email); expect(button('Renommer')).toBeUndefined();
});

it('uses the scoped native keychain session on a remote Tauri workspace', async () => {
  const invoke = vi.fn().mockResolvedValue('native-token');
  Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
  const fetch = vi.fn().mockResolvedValue(response({teamspaces: []}));
  vi.stubGlobal('fetch', fetch); openTeamspaces(ref); await has('Aucun espace d’équipe');
  expect(invoke).toHaveBeenCalledWith('load_cloud_session', {server: ref.server});
  expect(fetch.mock.calls[0]![1].headers.get('Authorization')).toBe('Bearer native-token');
});
