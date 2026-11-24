import { afterEach, expect, it, vi } from 'vitest';
import { must } from '../test-helpers';
import type { RemoteWorkspace } from '../workspace-registry';
import { openTeamspaces, type TeamPageNavigation } from './teamspaces';

const ref: RemoteWorkspace = { kind: 'remote', id: 'w', workspaceId: 'équipe', accountId: 'me', name: 'Atelier', role: 'member', server: 'https://example.test' };
const base = ref.server + '/api/workspaces/%C3%A9quipe/teamspaces';
const team = { id: 'A', name: 'Alpha' };
const bob = { userId: 'go_bob', email: 'bob@example.test' };
const response = (value: unknown) => Response.json(value);
const emptyNavigation: TeamPageNavigation = { pages: () => [], canEdit: () => false, open: async () => {} };
function mockMembers(fetch: (url: string, init: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.endsWith('/pages') ? Promise.resolve(response({pages: []})) : fetch(url, init));
}
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
  mockMembers(fetch);
  openTeamspaces({ ...ref, role: 'viewer' }, emptyNavigation);
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
  mockMembers(fetch); openTeamspaces(ref, emptyNavigation);
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
  mockMembers(fetch); openTeamspaces(ref, emptyNavigation);
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
  mockMembers(fetch); openTeamspaces(ref, emptyNavigation);
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
  mockMembers(fetch); openTeamspaces(ref, emptyNavigation); await has('Aucun membre dans cette équipe');
  click('Renommer'); name('Proposition'); click('Enregistrer'); await has('Vos droits ne permettent plus cette action');
  expect(document.querySelector<HTMLInputElement>('form input')?.value).toBe('Proposition');
  click('Actualiser'); await has(bob.email); expect(button('Renommer')).toBeUndefined();
});

it('uses the scoped native keychain session on a remote Tauri workspace', async () => {
  const invoke = vi.fn().mockResolvedValue('native-token');
  Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
  const fetch = vi.fn().mockResolvedValue(response({teamspaces: []}));
  mockMembers(fetch); openTeamspaces(ref, emptyNavigation); await has('Aucun espace d’équipe');
  expect(invoke).toHaveBeenCalledWith('load_cloud_session', {server: ref.server});
  expect(fetch.mock.calls[0]![1].headers.get('Authorization')).toBe('Bearer native-token');
});

const visiblePage = { id: 'already', title: 'Page liée' };
const otherPage = { id: 'writable', title: 'Cahier' };
const readOnlyPage = { id: 'read', title: 'Lecture' };
const pagesUrl = base + '/A/pages';
function pageNavigation(): TeamPageNavigation {
  return { pages: () => [visiblePage, otherPage, readOnlyPage], canEdit: (id) => id !== 'read', open: vi.fn(async () => {}) };
}
function mockPages(handle: (url: string, init: RequestInit) => Promise<Response>, teams = [team]) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === base) return response({teamspaces: teams});
    if (url.endsWith('/members')) return response({members: [bob]});
    return handle(url, init);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('opens only the pages returned by the team directory through shell navigation, including for a viewer', async () => {
  mockPages(async () => response({pages: [visiblePage]}));
  const navigation = pageNavigation();
  openTeamspaces({...ref, role: 'viewer'}, navigation);
  await has('Pages de l’équipe (1)');
  expect(button('Cahier')).toBeUndefined();
  expect(button('Rattacher une page')).toBeUndefined();
  expect(button('Détacher Page liée de l’équipe')).toBeUndefined();
  click('Page liée');
  await vi.waitFor(() => expect(button('Fermer')).toBeUndefined());
  expect(navigation.open).toHaveBeenCalledWith('already', expect.any(AbortSignal));
});

it('offers editable unrelated pages and refreshes real links after each mutation without invoking a sharing or page API', async () => {
  let links = [visiblePage, readOnlyPage];
  const fetch = mockPages(async (url, init) => {
    if (url === pagesUrl) return response({pages: links});
    if (url !== pagesUrl + '/writable') throw new Error('Unexpected path: ' + url);
    links = init.method === 'PUT' ? [...links, otherPage] : links.filter(({id}) => id !== otherPage.id);
    return response({ok:true});
  });
  openTeamspaces(ref, pageNavigation());
  await has('Pages de l’équipe (2)');
  expect(button('Détacher Lecture de l’équipe')).toBeUndefined();
  click('Rattacher une page'); click('Choisir une page');
  const titles = [...document.querySelectorAll<HTMLElement>('[data-blok-testid="popover-item-title"]')];
  expect(titles.map((item) => item.textContent)).not.toContain(visiblePage.title);
  expect(titles.map((item) => item.textContent)).not.toContain(readOnlyPage.title);
  must(titles.find((item) => item.textContent === otherPage.title)).click(); click('Rattacher');
  await has('Pages de l’équipe (3)');
  click('Détacher Cahier de l’équipe'); await has('Pages de l’équipe (2)');
  expect(button('Cahier')).toBeUndefined();
  expect(fetch.mock.calls.filter(([,init]) => init.method).map(([url,init]) => [url, init.method])).toEqual([
    [pagesUrl + '/writable', 'PUT'], [pagesUrl + '/writable', 'DELETE'],
  ]);
});

it('discards old team pages and aborts outstanding reads when switching or closing', async () => {
  let finish!: (value: Response) => void;
  const hanging = new Promise<Response>((resolve) => { finish = resolve; });
  const fetch = mockPages(async () => hanging, [team, {id:'B',name:'Beta'}]);
  const close = openTeamspaces(ref, pageNavigation());
  await has('Beta'); click('Beta');
  await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/B/pages'))).toBe(true));
  const first = fetch.mock.calls.find(([url]) => url === pagesUrl)![1].signal;
  const second = fetch.mock.calls.find(([url]) => url.endsWith('/B/pages'))![1].signal;
  expect(first?.aborted).toBe(true); expect(second?.aborted).toBe(false);
  close(); expect(second?.aborted).toBe(true);
  finish(response({pages:[visiblePage]})); await hanging;
  expect(button('Page liée')).toBeUndefined();
});

it('retains the page link after a permission change and aborts a pending mutation on close', async () => {
  let count = 0;
  let mutationSignal: AbortSignal | null | undefined;
  let finish!: (value: Response) => void;
  const fetch = mockPages(async (url, init) => {
    if (url === pagesUrl) return response({pages:[visiblePage]});
    mutationSignal = init.signal;
    if (count++ === 0) return Response.json({error:'forbidden'}, {status:403});
    return new Promise((resolve) => { finish = resolve; });
  });
  openTeamspaces(ref, pageNavigation()); await has('Page liée');
  click('Détacher Page liée de l’équipe'); await has('Vos droits ne permettent plus cette action');
  expect(button('Page liée')).toBeDefined();
  click('Détacher Page liée de l’équipe');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  click('Fermer');
  expect(mutationSignal?.aborted).toBe(true); finish(response({ok:true}));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetch.mock.calls.filter(([url]) => url === pagesUrl)).toHaveLength(1);
});

it('keeps members usable and offers a retry when team pages cannot load', async () => {
  let attempts = 0;
  mockPages(async () => attempts++ === 0 ? Response.json({}, {status:503}) : response({pages:[visiblePage]}));
  openTeamspaces(ref, pageNavigation());
  await has('Actualiser les pages'); await has(bob.email);
  click('Actualiser les pages'); await has('Pages de l’équipe (1)');
});
