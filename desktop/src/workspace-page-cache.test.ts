import type { DatabaseRowPages } from '../../types/tools/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Workspace } from './workspace';
import type { WorkspaceIndex } from './storage';
import type { createPageFrame } from '@blok/sidebar';
import type * as SidebarModule from '@blok/sidebar';
type PageFrameOptions = Parameters<typeof createPageFrame>[0];
const state = vi.hoisted(() => ({ editors: [] as Array<{ holder: HTMLElement; data: unknown; collaboration?: {offline?: boolean; offlineScope?: string}; rowPages(): DatabaseRowPages | undefined; configuredReadOnly(): boolean; rename(title: string): void; destroyed: boolean; flush: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>, sidebarAction: null as PageFrameOptions['onAction'] | null, rowCalls: [] as Array<{rowId: string; mode: string}>, rowBodies: {} as Record<string,string> }));
vi.mock('@bloklabs/core/full', () => ({ allTools: {}, Blok: class {
  isReady: Promise<void>;
  data: unknown;
  destroyed = false;
  collaboration?: {offline?: boolean; offlineScope?: string};
  holder: HTMLElement;
  titleText = '';
  constructor(private config: { tools?: {database?: {config?: {rowPages?: DatabaseRowPages}}}; collaboration?: {offline?: boolean; offlineScope?: string}; holder: HTMLElement; readOnly?: boolean; pageTitle?: { onChange(title: string, change: {source: 'user' | 'remote'}): void }; persistence?: { load(): Promise<unknown>; save(data: unknown): Promise<void> } }) {
    this.holder = config.holder;
    this.collaboration = config.collaboration;
    const redactor = document.createElement('div'); redactor.dataset.blokRedactor = ''; this.holder.append(redactor);
    state.editors.push(this);
    this.isReady = Promise.resolve(config.persistence?.load()).then(data => { this.data = data; });
  }
  rowPages(): DatabaseRowPages | undefined { return this.config.tools?.database?.config?.rowPages; }
  readOnly = { set: vi.fn(async () => true) };
  width = { set: vi.fn() };
  theme = { set: vi.fn() };
  title = { get: () => this.titleText, set: (text: string) => { this.titleText = text; }, icon: { get: () => undefined } };
  toolbar = { close: vi.fn(), toggleBlockSettings: vi.fn(), toggleToolbox: vi.fn() };
  inlineToolbar = { close: vi.fn() };
  blocks = { getById: (id: string) => id === 'db' ? {
    id, name: 'database', holder: this.holder,
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
    call: (_method: string, input: {receive(value:{pageId?:string}):void}) => input.receive({pageId:state.rowBodies[id]}),
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
async function go(id: string): Promise<void> {
  history.replaceState(null, '', `/?page=${id}`); workspace.onRoute();
  await vi.waitFor(() => expect(document.title).toBe(id));
}
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

async function startRemote(remoteOrigin = location.origin): Promise<{ index: WorkspaceIndex; writes: WorkspaceIndex[] }> {
  workspace.destroy();
  document.body.replaceChildren();
  state.editors.length = 0;
  const server = {
    index: {
      pages: ['a', 'b'].map(id => ({id, title: id, parentId: null})), activeId: 'a',
      access: {a: {level: 'full' as const}, b: {level: 'full' as const}},
    } as WorkspaceIndex,
    writes: [] as WorkspaceIndex[],
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
    if (url.pathname.includes('/resolve-id/')) return Response.json({pageId:'body',publicId:'77777777-7777-7777-7777-777777777777',title:'Row',workspace:{id:'remote-cache',slug:'cache-test',name:'Remote',role:'admin'},teamspaceId:null,rowBodyOf:{documentId:'a',rowId:'row-body'}});
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


it('opens a migrated body at its own public route, reloads its source row, and keeps parent page actions guarded', async () => {
  const server=await startRemote();
  state.rowBodies['row-body']='body';
  const host=editorAt(0).rowPages();
  host?.navigate?.('row-body',{databaseId:'db',pageId:'body'});
  await vi.waitFor(() => expect(location.pathname).toBe('/p/row-77777777-7777-7777-7777-777777777777'));
  await vi.waitFor(() => expect(document.title).toBe('row-body'));
  expect(location.hash).toBe('');
  expect(new URL(location.href).searchParams.has('row')).toBe(false);
  expect(document.querySelector('[data-desktop-page-breadcrumbs]')?.textContent).toContain('row-body');
  expect(document.querySelector('[data-desktop-row-page]')).not.toBeNull();
  const more=document.querySelector<HTMLButtonElement>('[data-desktop-page-more]');
  more?.click();
  const remove=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-desktop-page-menu] button')).find(button => button.textContent === 'Mettre à la corbeille');
  expect(remove).toBeDefined(); remove?.click();
  await workspace.flush();
  expect(server.index.pages.map(page=>page.id)).toEqual(['a','b']);

  workspace.destroy(); workspace.element.remove(); state.editors.length=0; state.rowCalls.length=0;
  const {createWorkspace}=await import('./workspace');
  workspace=createWorkspace(()=>undefined,()=>undefined,{ref:{kind:'remote',id:'remote-cache',name:'Remote',accountId:'user',workspaceId:'cache-test',server:location.origin,role:'admin'}});
  document.body.append(workspace.element); await workspace.start();
  await vi.waitFor(() => expect(document.title).toBe('row-body'));
  expect(state.rowCalls).toContainEqual({rowId:'row-body',mode:'full',explicit:true});
  expect(server.index.pages.map(page=>page.id)).toEqual(['a','b']);
  await go('b');
  expect(document.querySelector('[data-desktop-row-page]')).toBeNull();
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

it('retains nested row body editors while falling back to core full-page navigation for their databases',async()=>{
  await startRemote();
  const host=editorAt(0).rowPages();
  const holder=document.createElement('div');document.body.append(holder);
  const mounted=host?.mount('body',holder);
  await vi.waitFor(()=>expect(state.editors).toHaveLength(2));
  const nested=editorAt(1).rowPages();
  expect(nested?.mount).toBeTypeOf('function');
  expect(nested?.navigate).toBeUndefined();
  expect(nested?.navigation).toBeUndefined();
  expect(nested?.href).toBeUndefined();
  mounted?.destroy();holder.remove();
});
