import type { PageConfig } from '../../types/tools/page';
import type { DatabaseRowPages } from '../../types/tools/database';
import type { BlockAPI } from '../../types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Workspace } from './workspace';
import type { WorkspaceIndex } from './storage';
import type { createPageFrame } from '@blok/sidebar';
import type * as SidebarModule from '@blok/sidebar';
type PageFrameOptions = Parameters<typeof createPageFrame>[0];
const state = vi.hoisted(() => ({ editors: [] as Array<{ holder: HTMLElement; isReady: Promise<void>; data: unknown; pageConfig(): PageConfig | undefined; collaboration?: {offline?: boolean; offlineScope?: string}; rowPages(): DatabaseRowPages | undefined; configuredReadOnly(): boolean; rename(title: string): void; destroyed: boolean; flush: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>, sidebarAction: null as PageFrameOptions['onAction'] | null, rowCalls: [] as Array<{rowId: string; mode: string}>, rowBodies: {} as Record<string,string> }));
vi.mock('@bloklabs/core/full', () => ({ allTools: {}, Blok: class {
  isReady: Promise<void>;
  data: unknown;
  destroyed = false;
  collaboration?: {offline?: boolean; offlineScope?: string};
  holder: HTMLElement;
  titleText = '';
  constructor(private config: { tools?: {page?: {config?: PageConfig}; database?: {config?: {rowPages?: DatabaseRowPages}}}; collaboration?: {offline?: boolean; offlineScope?: string}; holder: HTMLElement; readOnly?: boolean; pageTitle?: { onChange(title: string, change: {source: 'user' | 'remote'}): void }; persistence?: { load(): Promise<unknown>; save(data: unknown): Promise<void> } }) {
    this.holder = config.holder;
    this.collaboration = config.collaboration;
    const redactor = document.createElement('div'); redactor.dataset.blokRedactor = ''; this.holder.append(redactor);
    state.editors.push(this);
    this.isReady = Promise.resolve(config.persistence?.load()).then(data => { this.data = data; });
  }
  pageConfig(): PageConfig | undefined { return this.config.tools?.page?.config; }
  rowPages(): DatabaseRowPages | undefined { return this.config.tools?.database?.config?.rowPages; }
  readOnly = { set: vi.fn(async () => true) };
  width = { set: vi.fn() };
  theme = { set: vi.fn() };
  title = { get: () => this.titleText, set: (text: string) => { this.titleText = text; }, icon: { get: () => undefined } };
  toolbar = { close: vi.fn(), toggleBlockSettings: vi.fn(), toggleToolbox: vi.fn() };
  inlineToolbar = { close: vi.fn() };
  blocks = { getById: (id: string) => id === 'db' ? {
    id, name: 'database', holder: this.holder, preservedData: {schema:[{id:'title',type:'title'}]},
    call: (method: string, input?: {rowId: string; mode: string}) => {
      const old=this.holder.querySelector('[data-blok-database-drawer-title]');
      if (method === 'closeRow') { old?.remove(); return; }
      if (!input) return;
      state.rowCalls.push(input);
      const title=document.createElement('textarea'); title.setAttribute('data-blok-database-drawer-title',''); title.value=input.rowId;
      if(old)old.replaceWith(title);else this.holder.append(title);
    },
  } : id.startsWith('row') ? {
    id, parentId: 'db', name: 'database-row',
    call: (_method: string, input: {receive(value:{pageId?:string;properties?:Record<string,string>}):void}) => input.receive({pageId:state.rowBodies[id],properties:{title:id}}),
  } : undefined };
  on = vi.fn();
  configuredReadOnly(): boolean { return this.config.readOnly === true; }
  rename(title: string): void { this.titleText = title; this.config.pageTitle?.onChange(title, {source: 'user'}); }
  flush = vi.fn(async () => undefined);
  saver = { flush: this.flush };
  save = async () => this.data;
  destroy = vi.fn(() => { this.destroyed = true; });
} }));
vi.mock('@blok/sidebar', async importOriginal => {
  const actual = await importOriginal<typeof SidebarModule>();
  return { ...actual, createPageFrame: (options: PageFrameOptions) => {
    state.sidebarAction = options.onAction;
    return actual.createPageFrame(options);
  } };
});
vi.mock('./page-comments', () => ({ mountPageComments: () => ({ element: document.createElement('div'), destroy: vi.fn() }) }));
vi.mock('./floating-toc', () => ({ createFloatingToc: () => ({ element: document.createElement('div'), destroy: vi.fn() }) }));
vi.mock('@blok/agent-assistant', () => ({ mountAgentAssistant: () => { const element = document.createElement('div'); const editorSlot = document.createElement('div'); element.append(editorSlot); return ({ element, editorSlot, open: vi.fn(), close: vi.fn(), destroy: vi.fn(), toggle: vi.fn() }); } }));
let workspace: Workspace;
beforeEach(async () => {
  vi.clearAllMocks();
  state.editors.length = 0;
  state.rowCalls.length = 0;
  state.rowBodies = {};
  state.sidebarAction = null;
  localStorage.clear(); document.body.replaceChildren();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  localStorage.setItem('blok:workspace:cache-test:index', JSON.stringify({ pages: ['a','b','c','d'].map(id => ({id,title:id,parentId:null})), activeId: 'a' }));
  for (const id of ['a','b','c','d']) localStorage.setItem(`blok:workspace:cache-test:${id}`, JSON.stringify({blocks: [{id:'p',type:'paragraph',data:{text:id}}]}));
  history.replaceState(null, '', '?page=a');
  const {createWorkspace} = await import('./workspace');
  workspace = createWorkspace(() => undefined, () => undefined, {ref: {kind:'local',id:'cache-test',name:'Test'}});
  document.body.append(workspace.element); await workspace.start();
  await vi.waitFor(() => expect(document.title).toBe('a'));
});
afterEach(() => { workspace?.destroy(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });
function editorAt(index: number) {
  const editor = state.editors[index];
  if (!editor) throw new Error(`Missing editor ${index}`);
  return editor;
}
async function go(id: string, title = id): Promise<void> {
  history.replaceState(null, '', `/?page=${id}`); workspace.onRoute();
  await vi.waitFor(() => expect(document.title).toBe(title));
}
/**
 * A local row's body is a block inside its page, not a document of its own, so
 * the desktop handed its database no row navigation at all: opening a row drew
 * it on screen without an address, and the breadcrumb kept naming the page. The
 * presentation reads blocks, so everything but the address was already there.
 */
it('gives a local row an address, so opening one full page is a navigation', async () => {
  const rows = editorAt(0).rowPages();

  expect(rows).toBeDefined();
  expect(rows?.href?.('row-one', { databaseId: 'db' })).toContain('row=row-one');

  rows?.navigate?.('row-one', { databaseId: 'db' });
  await vi.waitFor(() => expect(location.search).toContain('row=row-one'));
  expect(location.search).toContain('database=db');
  expect(location.search).toContain('page=a');
});

/**
 * A local row body used to be refused outright: the body lived as child blocks
 * of the row, so there was no document to mount. It is a document now, and the
 * pool that mounts one is the same code the server path uses — only its
 * configuration differs.
 */
/**
 * Once a row owns a document, its address is that document's — not a position
 * inside the page that happens to hold it. That is what makes the row survive
 * being moved, and what gives the page actions something to act on.
 */
/**
 * legacyPageUrl rebuilds the address from "/" and drops the query, `local=1`
 * with it. A reload then looked for the page on a server and showed it as
 * unavailable — the row's address has to stay inside the local workspace.
 */
it('keeps a row body address inside the local workspace', async () => {
  const rows = editorAt(0).rowPages() as { href?(rowId: string, context: {databaseId: string; pageId?: string}): string } | undefined;

  expect(rows?.href?.('row-one', { databaseId: 'db', pageId: 'body-1' })).toContain('local=1');
  expect(rows?.href?.('row-one', { databaseId: 'db' })).toContain('local=1');
});

it('addresses a row that owns a document by that document', async () => {
  const rows = editorAt(0).rowPages() as { href?(rowId: string, context: {databaseId: string; pageId?: string}): string } | undefined;

  expect(rows?.href?.('row-one', { databaseId: 'db' })).toContain('row=row-one');
  expect(rows?.href?.('row-one', { databaseId: 'db', pageId: 'body-1' })).toContain('page=body-1');
  expect(rows?.href?.('row-one', { databaseId: 'db', pageId: 'body-1' })).not.toContain('row=row-one');
});

it('offers a local row the same body pool the server path uses', async () => {
  const rows = editorAt(0).rowPages() as (ReturnType<NonNullable<typeof editorAt>> extends never ? never : Record<string, unknown>) | undefined;

  expect(typeof rows?.mount).toBe('function');
  expect(typeof rows?.prepare).toBe('function');
  expect(typeof rows?.flush).toBe('function');
  expect(typeof rows?.mountedEditor).toBe('function');
  // The link lives on the row block, so nothing has to be looked up for it.
  await expect((rows?.lookup as (input: {rowId: string}) => Promise<unknown>)({ rowId: 'row-one' })).resolves.toBeNull();
});

it('reuses a rendered page on A → B → A, with only the visible editor accepting input', async () => {
  const first = editorAt(0);
  await go('b');
  expect(first.destroyed).toBe(false);
  expect(first.holder.closest('[inert]')).not.toBeNull();
  expect(first.holder.isConnected).toBe(false);
  await go('a');
  expect(state.editors).toHaveLength(2);
  expect(first.holder.isConnected).toBe(true);
  expect(first.holder.closest('[inert]')).toBeNull();
  expect(first.flush).toHaveBeenCalled();
});
it('evicts the least recent page and destroys every retained editor on workspace disposal', async () => {
  await go('b'); await go('c'); await go('a');
  expect(state.editors).toHaveLength(3);
  await go('d');
  expect(editorAt(1).destroyed).toBe(true);
  expect(editorAt(0).destroyed).toBe(false);
  workspace.destroy();
  expect(state.editors.every(editor => editor.destroyed)).toBe(true);
  workspace.onRoute();
  expect(state.editors).toHaveLength(4);
});
it('reloads a local page when another writer changed it while it was cached', async () => {
  const first = editorAt(0); await go('b');
  localStorage.setItem('blok:workspace:cache-test:a', JSON.stringify({blocks:[{id:'fresh',type:'paragraph',data:{text:'Other writer'}}]}));
  await go('a');
  expect(first.destroyed).toBe(true);
  expect(state.editors).toHaveLength(3);
  const stored = JSON.parse(localStorage.getItem('blok:workspace:cache-test:a') ?? '{}') as {blocks: Array<{id: string}>};
  expect(stored.blocks[0]?.id).toBe('fresh');
});

function requestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(body) as unknown;
}

async function startRemote(remoteOrigin = location.origin, pages: WorkspaceIndex['pages'] = ['a', 'b'].map(id => ({id, title: id, parentId: null})), extraAccess: WorkspaceIndex['access'] = {}): Promise<{ index: WorkspaceIndex; writes: WorkspaceIndex[]; locations: Record<string, unknown> }> {
  workspace.destroy();
  document.body.replaceChildren();
  state.editors.length = 0;
  const server = {
    index: {
      pages, activeId: 'a',
      access: {...Object.fromEntries(pages.map(page => [page.id, {level:'full' as const}])), ...extraAccess},
    } as WorkspaceIndex,
    writes: [] as WorkspaceIndex[],
    locations: {} as Record<string, unknown>,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const inputUrl = typeof input === 'string' || input instanceof URL ? input : input.url;
    const url = new URL(inputUrl, location.href);
    if (url.pathname.endsWith('/index')) {
      if (init?.method === 'PUT') {
        const body = requestBody(init.body) as WorkspaceIndex;
        server.index.pages = body.pages;
        server.writes.push(structuredClone(body));
      }
      return Response.json({...structuredClone(server.index), revision: 1});
    }
    if (url.pathname.endsWith('/duplicate')) {
      const copy = requestBody(init?.body) as WorkspaceIndex['pages'][number];
      server.index.pages.push(copy);
      if (server.index.access) server.index.access[copy.id] = {level: 'full'};
      return Response.json({});
    }
    if (url.pathname.includes('/resolve-id/') && (url.pathname.split('/').at(-1) ?? '') in server.locations) return Response.json(server.locations[url.pathname.split('/').at(-1) ?? '']);
    if (url.pathname.includes('/resolve-id/') || url.pathname.includes('/resolve/')) return Response.json({pageId:'body',publicId:'77777777-7777-7777-7777-777777777777',title:'Row',workspace:{id:'remote-cache',slug:'cache-test',name:'Remote',role:'admin'},teamspaceId:null,rowBodyOf:{documentId:'a',rowId:'row-body'}});
    if (url.pathname.endsWith('/teamspaces')) return Response.json({teamspaces: []});
    return Response.json({});
  }));
  history.replaceState(null, '', '?page=a');
  const {createWorkspace} = await import('./workspace');
  workspace = createWorkspace(() => undefined, () => undefined, {ref: {
    kind: 'remote', id: 'remote-cache', name: 'Remote', accountId: 'user', workspaceId: 'cache-test', server: remoteOrigin, role: 'admin',
  }});
  document.body.append(workspace.element);
  await workspace.start();
  await vi.waitFor(() => expect(document.title).toBe('a'));
  return server;
}

it('saves a warm page title after remote duplication replaced the manifest objects', async () => {
  const server = await startRemote();
  const first = state.editors[0];
  expect(first).toBeDefined();
  await go('b');
  state.sidebarAction?.({id: 'b', type: 'duplicate'});
  await vi.waitFor(() => expect(document.title).toBe('b (copie)'));
  await go('a');
  expect(state.editors).toHaveLength(3);
  first?.rename('Changed from warm editor');
  await workspace.flush();

  expect(server.writes.at(-1)?.pages.find(page => page.id === 'a')?.title).toBe('Changed from warm editor');
});

it('persists recent local edits before caching and reuses the same editor on return', async () => {
  const first = state.editors[0];
  if (!first) throw new Error('Missing initial editor');
  first.data = {blocks: [{id: 'p', type: 'paragraph', data: {text: 'Recent edit'}}]};

  await go('b');

  const stored = JSON.parse(localStorage.getItem('blok:workspace:cache-test:a') ?? '{}') as {blocks: Array<{data: {text: string}}>};
  expect(stored.blocks[0]?.data.text).toBe('Recent edit');
  await go('a');
  expect(state.editors).toHaveLength(2);
  expect(first.destroyed).toBe(false);
  expect(first.holder.isConnected).toBe(true);
  await workspace.flush();
  expect(localStorage.getItem('blok:workspace:cache-test:a')).toContain('Recent edit');
});

it('disposes a warm remote editor when its edit access is reduced before reopening', async () => {
  const server = await startRemote();
  const first = editorAt(0);
  await go('b');
  if (!server.index.access) throw new Error('Missing access map');
  server.index.access.a = {level: 'view'};

  window.dispatchEvent(new Event('focus'));

  await vi.waitFor(() => expect(first.destroyed).toBe(true));
  await go('a');
  expect(state.editors).toHaveLength(3);
  expect(editorAt(2).configuredReadOnly()).toBe(true);
});

it('disposes a warm remote editor when its page disappears from the accessible manifest', async () => {
  const server = await startRemote();
  const first = editorAt(0);
  await go('b');
  server.index.pages = server.index.pages.filter(page => page.id !== 'a');
  if (server.index.access) delete server.index.access.a;

  window.dispatchEvent(new Event('focus'));

  await vi.waitFor(() => expect(first.destroyed).toBe(true));
  expect(first.holder.isConnected).toBe(false);
  expect(document.title).toBe('b');
  await workspace.flush();
  expect(server.index.pages.some(page => page.id === 'a')).toBe(false);
});

it.each([false, true])('opens a different page at the top after mounting (cached: %s)', async cached => {
  const canvas = editorAt(0).holder.closest('article')?.parentElement;
  if (!canvas) throw new Error('Missing page canvas');
  if (cached) { canvas.scrollTop = 420; await go('b'); }
  canvas.scrollTop = 870;
  vi.mocked(window.scrollTo).mockClear();

  await go(cached ? 'a' : 'b');

  expect(canvas.scrollTop).toBe(0);
  expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  expect(state.editors).toHaveLength(2);
});

it('does not reset scrolling when routing to the page already open', async () => {
  const canvas = editorAt(0).holder.closest('article')?.parentElement;
  if (!canvas) throw new Error('Missing page canvas');
  canvas.scrollTop = 870;
  vi.mocked(window.scrollTo).mockClear();

  workspace.onRoute();
  await workspace.flush();

  expect(canvas.scrollTop).toBe(870);
  expect(window.scrollTo).not.toHaveBeenCalled();
});


it('keeps remote page data across reloads in a stable account and workspace partition', async () => {
  await startRemote();
  const first = editorAt(0);

  expect(first.collaboration?.offline).toBe(true);
  expect(JSON.parse(first.collaboration?.offlineScope ?? 'null')).toEqual(['remote', location.origin, 'user', 'cache-test']);
  await go('b');
  expect(editorAt(1).collaboration?.offlineScope).toBe(first.collaboration?.offlineScope);
});

it('opens remote row bodies only on demand and flushes/destroys them with their page', async () => {
  await startRemote();
  const page = editorAt(0);
  expect(state.editors).toHaveLength(1);
  const rows = page.rowPages();
  expect(rows).toBeDefined();
  const holder = document.createElement('div');
  page.holder.append(holder);
  rows!.mount('body', holder);
  expect(state.editors).toHaveLength(2);
  const body = editorAt(1);
  expect(body.collaboration).toMatchObject({doc: 'body', offline: true, offlineScope: page.collaboration?.offlineScope});
  await workspace.flush();
  expect(body.flush).toHaveBeenCalled();
  workspace.destroy();
  expect(body.destroy).toHaveBeenCalledTimes(1);
});


it('expands a row into a reloadable host route and restores its parent without adding body pages to the manifest', async () => {
  const server = await startRemote();
  const first = editorAt(0);
  const host = first.rowPages();
  const canvas=first.holder.closest('article')?.parentElement;
  if(!canvas)throw new Error('Missing page canvas');
  canvas.scrollTop=280;
  expect(host?.navigate).toBeTypeOf('function');
  host?.navigate?.('row-one', {databaseId: 'db'});
  await vi.waitFor(() => expect(state.rowCalls).toContainEqual({rowId: 'row-one', mode: 'full', explicit: true}));
  expect(new URL(location.href).searchParams.get('row')).toBe('row-one');
  expect(canvas.scrollTop).toBe(0);
  expect(host?.navigation?.current()).toEqual({rowId:'row-one',databaseId:'db'});
  expect(server.index.pages.map(page => page.id)).toEqual(['a','b']);

  history.replaceState(null, '', '?page=a&row=row-two&database=db');
  workspace.onRoute();
  await vi.waitFor(() => expect(state.rowCalls).toContainEqual({rowId:'row-two',mode:'full',explicit:true}));
  host?.navigation?.back();
  await vi.waitFor(() => expect(new URL(location.href).searchParams.has('row')).toBe(false));
  await vi.waitFor(()=>expect(document.title).toBe('a'));
  expect(canvas.scrollTop).toBe(280);
  expect(first.destroyed).toBe(false);

  history.replaceState(null, '', '?page=a&row=row-one&database=db');
  workspace.destroy(); workspace.element.remove();
  state.editors.length = 0;
  const {createWorkspace} = await import('./workspace');
  workspace = createWorkspace(() => undefined, () => undefined, {ref: {kind:'remote',id:'remote-cache',name:'Remote',accountId:'user',workspaceId:'cache-test',server:location.origin,role:'admin'}});
  document.body.append(workspace.element);
  state.rowCalls.length = 0;
  await workspace.start();
  await vi.waitFor(() => expect(state.rowCalls).toContainEqual({rowId:'row-one',mode:'full',explicit:true}));
  expect(state.editors).toHaveLength(1);
});


it('returns to the row and its scroll position after visiting its parent breadcrumb', async () => {
  await startRemote();
  const page = editorAt(0);
  const canvas = page.holder.closest('article')?.parentElement;
  if (!canvas) throw new Error('Missing page canvas');
  page.rowPages()?.navigate?.('row-one', {databaseId:'db'});
  await vi.waitFor(() => expect(document.title).toBe('row-one'));
  const rowUrl = location.href;
  canvas.scrollTop = 475;
  const parent = document.querySelector<HTMLButtonElement>('[data-desktop-page-breadcrumb-item][data-page-id="a"] button');
  expect(parent).not.toBeNull();
  parent!.click();
  await vi.waitFor(() => expect(document.title).toBe('a'));
  const parentUrl = location.href;
  const entries = history.length;
  // The crumb of the page already open goes to that page, which is a move to
  // where we already are: it must leave the history alone, or going back would
  // land on the page instead of the row.
  document.querySelector<HTMLButtonElement>('[data-desktop-page-breadcrumb-item] button[aria-current="page"]')!.click();
  expect(history.length).toBe(entries);
  const traverse = (direction: 'back' | 'forward') => new Promise<void>(resolve => {
    window.addEventListener('popstate', () => { workspace.onRoute(); resolve(); }, {once:true});
    history[direction]();
  });
  await traverse('back');
  await vi.waitFor(() => expect(document.title).toBe('row-one'));
  expect(location.href).toBe(rowUrl);
  expect(canvas.scrollTop).toBe(475);
  await traverse('forward');
  await vi.waitFor(() => expect(document.title).toBe('a'));
  expect(location.href).toBe(parentUrl);
});

it('opens a migrated body in its own session, keeps its actions and reloads without indexing it', async () => {
  const server = await startRemote(location.origin, undefined, {body: {level:'full', publicId:'77777777-7777-7777-7777-777777777777'}});
  state.rowBodies['row-body'] = 'body';
  const host = editorAt(0);
  host.rowPages()?.navigate?.('row-body', {databaseId:'db', pageId:'body'});
  await vi.waitFor(() => expect(location.pathname).toBe('/p/row-77777777-7777-7777-7777-777777777777'));
  await vi.waitFor(() => expect(document.title).toBe('Row'));
  expect(editorAt(1).collaboration).toMatchObject({doc:'body'});
  expect(state.rowCalls).toEqual([]);
  expect(document.querySelector('[data-desktop-row-page]')).toBeNull();
  expect(document.querySelector('[data-desktop-page-share]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-desktop-page-favorite]')?.click();
  const storedFavorites = Object.keys(localStorage).filter(key => key.startsWith('blok:navigation:favorites:')).map(key => JSON.parse(localStorage.getItem(key) ?? '[]') as string[]).flat();
  // Personal favorites must name the body; the parent must stay untouched.
  expect(storedFavorites).toContain('body');
  expect(storedFavorites).not.toContain('a');
  document.querySelector<HTMLButtonElement>('[data-desktop-page-more]')?.click();
  const menu = document.querySelector('[data-desktop-page-menu]');
  expect(menu?.textContent).toContain('Historique des versions');
  expect(menu?.textContent).toContain('Renommer');
  expect(menu?.textContent).not.toContain('Déplacer vers');
  expect(menu?.textContent).not.toContain('Mettre à la corbeille');
  editorAt(1).rename('Own title');
  await workspace.flush();
  expect(document.title).toBe('Own title');
  expect(server.index.pages.map(page => [page.id, page.title])).toEqual([['a','a'],['b','b']]);
  expect(server.writes).toEqual([]);

  workspace.destroy(); workspace.element.remove(); state.editors.length = 0;
  const {createWorkspace} = await import('./workspace');
  workspace = createWorkspace(() => undefined, () => undefined, {ref:{kind:'remote',id:'remote-cache',name:'Remote',accountId:'user',workspaceId:'cache-test',server:location.origin,role:'admin'}});
  document.body.append(workspace.element); await workspace.start();
  await vi.waitFor(() => expect(editorAt(0).collaboration).toMatchObject({doc:'body'}));
  expect(server.index.pages.map(page => page.id)).toEqual(['a','b']);
  await go('b');
  expect(document.querySelector('[data-desktop-row-page]')).toBeNull();
});

it('shares and duplicates the body document without acting on its parent', async () => {
  const server = await startRemote(location.origin, undefined, {body:{level:'full'}});
  const sharing = await import('./cloud/page-sharing');
  const share = vi.spyOn(sharing, 'openPageSharing').mockImplementation(() => () => undefined);
  editorAt(0).rowPages()?.navigate?.('row-body', {databaseId:'db',pageId:'body'});
  await vi.waitFor(() => expect(document.title).toBe('Row'));
  document.querySelector<HTMLButtonElement>('[data-desktop-page-share]')?.click();
  expect(share.mock.calls.at(-1)?.slice(1, 3)).toEqual(['body', 'Row']);
  document.querySelector<HTMLButtonElement>('[data-desktop-page-more]')?.click();
  const copy = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-desktop-page-menu] button')).find(button => button.textContent === 'Dupliquer');
  expect(copy).toBeDefined(); copy?.click();
  await vi.waitFor(() => expect(document.title).toBe('Row (copie)'));
  expect(vi.mocked(fetch).mock.calls.some(([url, init]) => (url instanceof Request ? url.url : String(url)).endsWith('/pages/body/duplicate') && init?.method === 'POST')).toBe(true);
  expect(server.index.pages.some(page => page.id === 'body')).toBe(false);
  expect(server.index.pages.find(page => page.id === 'a')?.title).toBe('a');
});

it('opens a native body route in a body session while preserving the app origin', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {invoke:vi.fn(async () => null)});
  await startRemote('https://native-server.example', undefined, {body:{level:'full'}});
  const origin = location.origin;
  editorAt(0).rowPages()?.navigate?.('row-body', {databaseId:'db',pageId:'body'});
  await vi.waitFor(() => expect(document.title).toBe('Row'));
  expect(location.origin).toBe(origin);
  expect(new URL(location.href).searchParams.get('page')).toBe('body');
  expect(editorAt(1).collaboration).toMatchObject({doc:'body'});
});

it('presents an inline row inside a standalone body using that body session, then restores its document actions', async () => {
  const server = await startRemote(location.origin, undefined, {body:{level:'full'}});
  history.replaceState(null, '', '?page=body&row=row-inline&database=db'); workspace.onRoute();
  await vi.waitFor(() => expect(document.title).toBe('row-inline'));
  expect(editorAt(1).collaboration).toMatchObject({doc:'body'});
  expect(editorAt(1).rowPages()?.navigation?.current()).toEqual({rowId:'row-inline',databaseId:'db'});
  expect(editorAt(0).rowPages()?.navigation?.current()).toBeNull();
  await go('body', 'Row');
  expect(document.querySelector('[data-desktop-row-page]')).toBeNull();
  expect(editorAt(1).destroyed).toBe(false);
  expect(server.writes).toEqual([]);
});

it('opens a body from a cold URL even when only the body is shared, then closes it on access loss', async () => {
  const server = await startRemote(location.origin, [{id:'a',title:'a',parentId:null}], {body: {level:'view', publicId:'77777777-7777-7777-7777-777777777777'}});
  server.locations.body = {pageId:'body', publicId:'77777777-7777-7777-7777-777777777777', title:'Shared body', workspace:{id:'remote-cache',slug:'cache-test',name:'Remote',role:'admin'},teamspaceId:null};
  history.replaceState(null, '', '?page=body'); workspace.onRoute();
  await vi.waitFor(() => expect(document.title).toBe('Shared body'));
  expect(editorAt(1).collaboration).toMatchObject({doc:'body'});
  expect(editorAt(1).configuredReadOnly()).toBe(true);
  expect(document.querySelector('[data-desktop-page-breadcrumbs]')?.textContent).not.toContain('row-body');
  server.index.access = {};
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(document.querySelector('[data-page-unavailable]')).not.toBeNull());
  expect(editorAt(1).destroyed).toBe(true);
  expect(server.writes).toEqual([]);
});

it('reloads a local body in its own editor, edits its content, and keeps the workspace index unchanged', async () => {
  workspace.destroy(); workspace.element.remove(); state.editors.length = 0;
  const index = localStorage.getItem('blok:workspace:cache-test:index');
  localStorage.setItem('blok:workspace:cache-test:a', JSON.stringify({blocks:[{id:'db',type:'database',data:{}},{id:'row-one',type:'database-row',parent:'db',data:{pageId:'local-body',bodyBlocks:true}}]}));
  localStorage.setItem('blok:workspace:cache-test:row-bodies', JSON.stringify({'local-body':{publicId:'11111111-1111-4111-8111-111111111111',documentId:'a',rowId:'row-one',databaseId:'db',title:'Local row'}}));
  localStorage.setItem('blok:workspace:cache-test:local-body', JSON.stringify({blocks:[{id:'text',type:'paragraph',data:{text:'Same content'}}]}));
  history.replaceState(null, '', '?page=local-body&local=1');
  const {createWorkspace} = await import('./workspace');
  workspace = createWorkspace(() => undefined, () => undefined, {ref:{kind:'local',id:'cache-test',name:'Test'}});
  document.body.append(workspace.element); await workspace.start();
  await vi.waitFor(() => expect(document.title).toBe('Local row'));
  await editorAt(0).isReady;
  expect(editorAt(0).data).toMatchObject({blocks:[{id:'text',data:{text:'Same content'}}]});
  editorAt(0).data = {title:'Body title',blocks:[{id:'text',type:'paragraph',data:{text:'Edited content'}}]};
  editorAt(0).rename('Body title');
  await workspace.flush();
  expect(localStorage.getItem('blok:workspace:cache-test:local-body')).toContain('Edited content');
  expect(localStorage.getItem('blok:workspace:cache-test:index')).toBe(index);
  await editorAt(0).pageConfig()?.create?.({pageId:'local-child',title:'Child'});
  const withChild = JSON.parse(localStorage.getItem('blok:workspace:cache-test:index') ?? '{}') as WorkspaceIndex;
  expect(withChild.pages.find(page => page.id === 'local-child')).toMatchObject({title:'Child',parentId:'a'});
  await go('a');
  const target = document.createElement('div'); document.body.append(target);
  const mounted = editorAt(1).rowPages()?.mount('local-body', target);
  await vi.waitFor(() => expect(editorAt(2).data).toMatchObject({blocks:[{data:{text:'Edited content'}}]}));
  localStorage.setItem('blok:workspace:cache-test:local-body', JSON.stringify({blocks:[{id:'text',type:'paragraph',data:{text:'External update'}}]}));
  await workspace.flush();
  expect(localStorage.getItem('blok:workspace:cache-test:local-body')).toContain('External update');
  mounted?.destroy();
});

it('duplicates the latest local body content as an ordinary page without retaining its row ancestry', async () => {
  workspace.destroy(); workspace.element.remove(); state.editors.length = 0;
  localStorage.setItem('blok:workspace:cache-test:row-bodies', JSON.stringify({'copy-body':{publicId:'11111111-1111-4111-8111-111111111111',documentId:'a',rowId:'row-one',title:'Body'}}));
  localStorage.setItem('blok:workspace:cache-test:copy-body', JSON.stringify({title:'Body',blocks:[{id:'text',type:'paragraph',data:{text:'Old content'}}]}));
  history.replaceState(null, '', '?page=copy-body&local=1');
  const {createWorkspace} = await import('./workspace');
  workspace = createWorkspace(() => undefined, () => undefined, {ref:{kind:'local',id:'cache-test',name:'Test'}});
  document.body.append(workspace.element); await workspace.start();
  await vi.waitFor(() => expect(document.title).toBe('Body'));
  await editorAt(0).isReady;
  editorAt(0).data = {title:'Body',blocks:[{id:'text',type:'paragraph',data:{text:'Latest edit'}}]};
  document.querySelector<HTMLButtonElement>('[data-desktop-page-more]')?.click();
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-desktop-page-menu] button')).find(button => button.textContent === 'Dupliquer')?.click();
  await vi.waitFor(() => expect(document.title).toBe('Body (copie)'));
  expect([...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(crumb => crumb.textContent)).toEqual(['a','Body (copie)']);
  const index = JSON.parse(localStorage.getItem('blok:workspace:cache-test:index') ?? '{}') as WorkspaceIndex;
  const copy = index.pages.find(page => page.title === 'Body (copie)');
  if (!copy) throw new Error('Missing body copy');
  expect(copy.parentId).toBe('a');
  expect(copy.location).toBeUndefined();
  expect(index.pages.some(page => page.id === 'copy-body')).toBe(false);
  expect(localStorage.getItem(`blok:workspace:cache-test:${copy.id}`)).toContain('Latest edit');
});

it.each([false,true])('ignores a delayed row resolver after leaving its source (rejected: %s)', async rejected => {
  await startRemote(); state.rowBodies['row-body']='body';
  const original=fetch;
  let finish: ((response:Response)=>void) | undefined;
  const pending=new Promise<Response>(resolve=>{finish=resolve;});
  let requested=false;
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(typeof input === 'string' || input instanceof URL ? input : input.url,location.href);
    if(url.pathname.includes('/resolve-id/')){requested=true;return pending;}
    return original(input,init);
  }));
  editorAt(0).rowPages()?.navigate?.('row-body',{databaseId:'db',pageId:'body'});
  await vi.waitFor(()=>expect(requested).toBe(true));
  await go('b');
  if(!finish)throw new Error('Missing pending resolver');
  finish(rejected ? Response.json({error:'stale row resolver failure'},{status:404}) : Response.json({pageId:'body',publicId:'77777777-7777-7777-7777-777777777777',title:'Row',workspace:{id:'remote-cache',slug:'cache-test',name:'Remote',role:'admin'},teamspaceId:null,rowBodyOf:{documentId:'a',rowId:'row-body'}}));
  await pending; await workspace.flush(); await Promise.resolve();
  expect(document.title).toBe('b');
  expect(new URL(location.href).searchParams.get('page')).toBe('b');
  expect(document.body.textContent).not.toContain('stale row resolver failure');
});

it('rejects a row route that names another database instead of showing its source page', async()=>{
  await startRemote();
  history.replaceState(null,'','?page=a&row=row-one&database=other');workspace.onRoute();
  await vi.waitFor(()=>expect(document.querySelector('[data-page-unavailable]')).not.toBeNull());
  expect(state.rowCalls).toEqual([]);
});


it('uses a native same-origin route for an unmigrated row and a public URL when copying it',async()=>{
  vi.stubGlobal('__TAURI_INTERNALS__',{invoke:vi.fn(async()=>null)});
  await startRemote('https://native-server.example');
  const host=editorAt(0).rowPages();
  host?.navigate?.('row-native',{databaseId:'db'});
  await vi.waitFor(()=>expect(document.title).toBe('row-native'));
  expect(location.origin).not.toBe('https://native-server.example');
  expect(new URL(location.href).searchParams.get('page')).toBe('a');
  expect(host?.href?.('row-native',{databaseId:'db'})).toBe('https://native-server.example/?page=a&row=row-native&database=db');
});

it.each(['expand', 'legacy full link'])('routes a nested task through its physical sprint body (%s)', async (entry) => {
  const server = await startRemote(location.origin, undefined, {'sprint-body':{level:'full'}, 'task-body':{level:'full'}});
  const publicId = '99999999-9999-9999-9999-999999999999';
  state.rowBodies['row-sprint'] = 'sprint-body';
  state.rowBodies['row-task'] = 'task-body';
  server.locations['task-body'] = {
    pageId:'task-body', publicId, title:'Task', workspace:{id:'remote-cache', slug:'cache-test'},
    rowBodyOf:{documentId:'sprint-body', rowId:'row-task'},
    location:{documentId:'a', rows:[
      {documentId:'a', databaseId:'db', rowId:'row-sprint', title:'Sprint'},
      {documentId:'sprint-body', databaseId:'db', rowId:'row-task', title:'Task'},
    ]},
  };
  const holder = document.createElement('div'); document.body.append(holder);
  const mounted = editorAt(0).rowPages()?.mount('sprint-body', holder);
  await editorAt(1).isReady;
  const nested = editorAt(1).rowPages();
  const context = {databaseId:'db', pageId:'task-body'};
  expect(nested?.href?.('row-task', context)).toBe(location.origin+'/?page=task-body');
  expect(nested?.href?.('row-inline', {databaseId:'db'})).toBe(location.origin+'/?page=sprint-body&row=row-inline&database=db');
  if (entry === 'legacy full link') history.replaceState(null, '', '/?page=sprint-body#row-task?full');
  const historyLength = history.length;
  nested?.navigate?.('row-task', context);
  await vi.waitFor(() => expect(location.pathname).toBe('/p/task-'+publicId));
  expect(location.hash).toBe('');
  expect(history.length).toBe(historyLength + (entry === 'expand' ? 1 : 0));
  expect(nested?.navigation?.current()).toBeNull();
  await vi.waitFor(() => expect(document.title).toBe('Task'));
  expect(editorAt(2).collaboration).toMatchObject({doc:'task-body'});
  const trail = [...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(crumb => crumb.textContent);
  expect(trail).toEqual(['a', 'Sprint', 'Task']);
  mounted?.destroy();
});

it('opens nested rows through workspace routing and returns to their parent using native breadcrumbs and Back', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {invoke: vi.fn(async () => null)});
  await startRemote('https://native-server.example');
  const editor = editorAt(0);
  const surface = document.createElement('div');
  surface.setAttribute('data-blok-editor', '');
  editor.holder.append(surface);
  const block = (id: string, name: string, parentId: string | null, data: BlockAPI['preservedData']): BlockAPI => ({
    id, name, parentId, holder: document.createElement('div'), preservedData: data,
    call: vi.fn((method: string, input?: object) => {
      if (method === 'readData' && input && 'receive' in input && typeof input.receive === 'function') input.receive(data);
    }),
  } as unknown as BlockAPI);
  const schema = [{id: 'title', type: 'title'}];
  const root = block('db', 'database', null, {schema});
  const parent = block('row-parent', 'database-row', root.id, {properties: {title: 'Parent'}});
  const childDatabase = block('db-child', 'database', parent.id, {schema});
  const child = block('row-child', 'database-row', childDatabase.id, {properties: {title: 'Child'}});
  surface.append(root.holder);
  root.holder.append(parent.holder);
  parent.holder.setAttribute('data-blok-editor', '');
  parent.holder.append(childDatabase.holder);
  childDatabase.holder.append(child.holder);
  const graph = new Map([root, parent, childDatabase, child].map(item => [item.id, item]));
  Reflect.set(editor, 'blocks', {getById: (id: string) => graph.get(id)});
  const opened: string[] = [];
  const drawers = new Map<string, HTMLElement>();
  const databaseCalls = (database: BlockAPI, row: BlockAPI, title: string) => vi.fn((method: string) => {
    if (method !== 'openRow' && method !== 'closeRow') return;
    const previous = drawers.get(database.id);
    if (previous) {
      database.holder.append(row.holder);
      previous.remove(); drawers.delete(database.id);
    }
    if (method === 'closeRow') {
      if (database === childDatabase) drawers.get(root.id)?.removeAttribute('data-blok-database-full-page');
      return;
    }
    opened.push(row.id);
    const drawer = document.createElement('div');
    drawer.setAttribute('data-blok-database-drawer', ''); drawer.setAttribute('data-peek-mode', 'full');
    const content = document.createElement('div'); content.setAttribute('data-blok-database-drawer-content', '');
    const heading = document.createElement('textarea'); heading.setAttribute('data-blok-database-drawer-title', ''); heading.value = title;
    const body = document.createElement('div'); body.setAttribute('data-blok-database-drawer-editor', '');
    content.append(heading, body); drawer.append(content); surface.append(drawer); body.append(row.holder);
    drawers.set(database.id, drawer);
    if (database === childDatabase) drawers.get(root.id)?.setAttribute('data-blok-database-full-page', '');
  });
  root.call = databaseCalls(root, parent, 'Parent');
  childDatabase.call = databaseCalls(childDatabase, child, 'Child');

  const openChild = async (): Promise<void> => {
    history.replaceState(null, '', '?page=a&row=row-child');
    workspace.onRoute();
    await vi.waitFor(() => expect(document.title).toBe('Child'));
  };
  await openChild();
  expect(opened).toEqual(['row-parent', 'row-child']);
  expect(root.call).toHaveBeenCalledWith('openRow', {rowId: parent.id, mode: 'full', explicit: true});
  expect(childDatabase.call).toHaveBeenCalledWith('openRow', {rowId: child.id, mode: 'full', explicit: true});
  const trail = document.querySelector('[data-desktop-page-breadcrumbs]');
  expect(trail?.textContent).toContain('Parent');
  expect(trail?.querySelector('[aria-current="page"]')?.textContent).toBe('Child');

  editor.rowPages()?.navigation?.back();
  await vi.waitFor(() => expect(document.title).toBe('Parent'));
  expect(new URL(location.href).searchParams.get('row')).toBe(parent.id);
  expect(new URL(location.href).searchParams.get('database')).toBe(root.id);
  expect(location.origin).not.toBe('https://native-server.example');

  await openChild();
  const ancestor = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-desktop-page-breadcrumbs] button')).find(button => button.textContent === 'Parent');
  if (!ancestor) throw new Error('Missing parent row breadcrumb');
  ancestor.click();
  await vi.waitFor(() => expect(document.title).toBe('Parent'));
  expect(new URL(location.href).searchParams.get('row')).toBe(parent.id);
  expect(location.origin).not.toBe('https://native-server.example');
});

it.each(['a','hidden-body'])('keeps five row ancestors in a subpage trail (storage parent %s) and opens the clicked row', async (storageParent) => {
  const rows = Array.from({length: 5}, (_, index) => ({documentId:'a', rowId:`row${index + 1}`, databaseId:'db', title:`Sprint ${index + 1}`}));
  await startRemote(location.origin, [
    {id:'a',title:'a',parentId:null},
    Object.assign({id:'b',title:'b',parentId:storageParent}, {location:{documentId:'a',blockId:'row5',rows}}),
    {id:'c',title:'c',parentId:'b'},
  ]);
  await go('b');
  const crumbs = () => [...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(element => element.textContent);
  expect(crumbs()).toEqual(['a', ...rows.map(row => row.title), 'b']);
  await go('c');
  expect(crumbs()).toEqual(['a', ...rows.map(row => row.title), 'b', 'c']);
  const row = document.querySelector<HTMLButtonElement>('[data-desktop-page-breadcrumb-item][data-page-id="row3"] button');
  expect(row).not.toBeNull();
  row?.click();
  await vi.waitFor(() => expect(new URL(location.href).searchParams.get('row')).toBe('row3'));
  expect(new URL(location.href).searchParams.get('page')).toBe('a');
  expect(new URL(location.href).searchParams.get('database')).toBe('db');
  await vi.waitFor(() => expect(state.rowCalls.at(-1)).toMatchObject({rowId:'row3', mode:'full'}));
});

it('refreshes a just-created subpage location without waiting for the manifest poll', async () => {
  const server = await startRemote(location.origin, [{id:'a',title:'a',parentId:null},{id:'b',title:'b',parentId:'a'}]);
  server.locations.b = {pageId:'b',publicId:'88888888-8888-8888-8888-888888888888',title:'b',workspace:{id:'remote-cache',slug:'cache-test'},location:{documentId:'a',blockId:'row1',rows:[{documentId:'a',rowId:'row1',databaseId:'db',title:'Sprint 1'}]}};
  await go('b');
  await vi.waitFor(() => expect([...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(element => element.textContent)).toEqual(['a','Sprint 1','b']));
  expect(server.writes).toEqual([]);
  editorAt(1).rename('Renamed');
  await vi.waitFor(() => expect(server.writes.length).toBeGreaterThan(0));
  await vi.waitFor(() => expect([...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(element => element.textContent)).toEqual(['a','Sprint 1','Renamed']));
  server.locations.b = {}; // A later resolver failure must not discard the confirmed ancestry.
  await go('a');
  history.replaceState(null, '', '/?page=b'); workspace.onRoute();
  await vi.waitFor(() => expect(document.title).toBe('Renamed'));
  expect([...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(element => element.textContent)).toEqual(['a','Sprint 1','Renamed']);
});

it('ignores a late body resolver after leaving its row breadcrumb', async () => {
  await startRemote(location.origin, [
    {id:'a',title:'a',parentId:null},
    Object.assign({id:'b',title:'b',parentId:'a'}, {location:{documentId:'a',blockId:'row2',rows:[{documentId:'a',rowId:'row1',databaseId:'db',title:'Sprint'},{documentId:'body',rowId:'row2',databaseId:'db',title:'Task'}]}}),
  ], {body:{level:'full'}});
  await go('b');
  const pending: {finish?: (response: Response) => void} = {};
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation((input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    if (href.endsWith('/resolve-id/body')) return new Promise<Response>(resolve => { pending.finish = resolve; });
    if (!original) throw new Error('Missing fetch implementation');
    return original(input, init);
  });
  document.querySelector<HTMLButtonElement>('[data-desktop-page-breadcrumb-item][data-page-id="row2"] button')?.click();
  await vi.waitFor(() => expect(pending.finish).toBeDefined());
  await go('a');
  pending.finish?.(Response.json({pageId:'body',publicId:'77777777-7777-7777-7777-777777777777',title:'Sprint',workspace:{id:'remote-cache',slug:'cache-test'},rowBodyOf:{documentId:'a',rowId:'row1'}}));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(new URL(location.href).searchParams.get('page')).toBe('a');
  expect(new URL(location.href).searchParams.has('row')).toBe(false);
  expect(document.title).toBe('a');
});

it.each(['root','body'])('keeps each host on its own row while routing across documents (%s)', async (scope) => {
  await startRemote();
  const {rememberResolvedRowPage} = await import('./page-urls');
  rememberResolvedRowPage(location.origin, {
    pageId:'body2',publicId:'99999999-9999-9999-9999-999999999999',title:'Nested',workspace:{id:'remote-cache',slug:'cache-test',name:'Remote',role:'admin'},teamspaceId:null,
    rowBodyOf:{documentId:'body1',rowId:'row2'},
    location:{documentId:'a',blockId:'row2',rows:[{documentId:'a',rowId:'row1',databaseId:'db',title:'Sprint'},{documentId:'body1',rowId:'row2',databaseId:'nested-db',title:'Task'}]},
  });
  history.replaceState(null, '', '/?page=body1&row=row2&database=nested-db');
  if (scope === 'root') {
    expect(editorAt(0).rowPages()?.navigation?.current()).toBeNull();
  } else {
    const holder = document.createElement('div'); document.body.append(holder);
    const mounted = editorAt(0).rowPages()?.mount('body1', holder);
    await editorAt(1).isReady;
    expect(editorAt(1).rowPages()?.navigation?.current()).toBeNull();
    mounted?.destroy();
  }
});

it('creates subpages in the physical row body document, preserving explicit parent choices', async () => {
  const server = await startRemote(location.origin, [{id:'a',title:'a',parentId:null}], {body1:{level:'full'}});
  const holder = document.createElement('div'); document.body.append(holder);
  const mounted = editorAt(0).rowPages()?.mount('body1', holder);
  await editorAt(1).isReady;
  const config = editorAt(1).pageConfig();
  expect(config?.create).toBeDefined();
  await config?.create?.({pageId:'child1',title:'Child 1'});
  await config?.create?.({pageId:'child2',title:'Child 2'});
  await config?.create?.({pageId:'child3',title:'Child 3',parentId:'a'});
  expect(server.writes.at(-1)?.pages.filter(page => page.id.startsWith('child')).map(page => [page.id,page.parentId])).toEqual([['child1','body1'],['child2','body1'],['child3','a']]);
  mounted?.destroy();
});

it('follows an MCP reparent between rows on the open page without rebuilding its editor', async () => {
  const parent = (rowId: string, title: string) => ({documentId:'a',blockDocumentId:'a',blockId:rowId,rows:[{documentId:'a',rowId,databaseId:'db',title}]});
  const server = await startRemote(location.origin, [
    {id:'a',title:'a',parentId:null},
    {id:'b',title:'Commits',parentId:'a',location:parent('row1','Sprint #1')},
  ]);
  await go('b', 'Commits');
  const editor = editorAt(1);
  const crumbs = () => [...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(element => element.textContent);
  expect(crumbs()).toEqual(['a','Sprint #1','Commits']);
  server.index.pages = server.index.pages.map(page => page.id === 'b' ? {...page,location:parent('row2','Sprint #2')} : page);
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(crumbs()).toEqual(['a','Sprint #2','Commits']));
  expect(editor.destroyed).toBe(false);
  expect(editor.holder.isConnected).toBe(true);
  expect(server.writes).toEqual([]);
  document.querySelector<HTMLButtonElement>('[data-desktop-page-breadcrumb-item][data-page-id="row2"] button')?.click();
  await vi.waitFor(() => expect(new URL(location.href).searchParams.get('row')).toBe('row2'));
  expect(new URL(location.href).searchParams.get('page')).toBe('a');
});

it('clears row ancestry after an MCP move to the workspace root, including a warm reopen', async () => {
  const server = await startRemote(location.origin, [
    {id:'a',title:'a',parentId:null},
    {id:'b',title:'Commits',parentId:'a',location:{documentId:'a',blockId:'row1',rows:[{documentId:'a',rowId:'row1',databaseId:'db',title:'Sprint #1'}]}},
  ]);
  await go('b', 'Commits');
  const crumbs = () => [...document.querySelectorAll('[data-desktop-page-breadcrumb-item]')].map(element => element.textContent);
  expect(crumbs()).toEqual(['a','Sprint #1','Commits']);
  server.index.pages = server.index.pages.map(page => page.id === 'b' ? {id:'b',title:'Commits',parentId:null} : page);
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(crumbs()).toEqual(['Commits']));
  await go('a');
  await go('b', 'Commits');
  expect(crumbs()).toEqual(['Commits']);
  expect(server.writes).toEqual([]);
});
