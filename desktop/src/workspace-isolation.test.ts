<<<<<<< HEAD
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialWorkspace, createLocalWorkspace, rememberWorkspace, workspaceKey, type RemoteWorkspace } from './workspace-registry';
import { readFile, writeFile, loadIndex } from './storage';
import { workspaceRepository } from './workspace-repository';
const remote: RemoteWorkspace = { kind: 'remote', id: 'r', name: 'Shared', server: 'https://example.org', accountId: 'a', workspaceId: 'team' };
afterEach(() => { localStorage.clear(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.unstubAllGlobals(); });
describe('workspace isolation', () => {
  it('preserves the existing default data without migration and isolates new locals', async () => {
    localStorage.setItem('blok:workspace:index', JSON.stringify({pages:[{id:'old',title:'Existing',parentId:null}],activeId:'old'}));
    expect((await loadIndex(initialWorkspace)).activeId).toBe('old');
    const other = createLocalWorkspace('Other');
    await writeFile('old', 'new content', other);
    expect(await readFile('old', initialWorkspace)).toBeNull();
    expect(await readFile('old', other)).toBe('new content');
    expect((await loadIndex(initialWorkspace)).activeId).toBe('old');
  });
  it('recovers a Markdown import after a failed index write without duplicating the document', async () => {
    const workspace = createLocalWorkspace('Import');
    const repository = workspaceRepository(workspace);
    const initial = await repository.loadIndex();
    const attempt = crypto.randomUUID();
    const source = '# Guide\n\nUn **mot** important.';
    const originalWrite = Storage.prototype.setItem;
    const failOnce = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith(':index')) throw new Error('Quota dépassé');
      originalWrite.call(this, key, value);
    });
    try {
      await expect(repository.importMarkdown(attempt, 'Guide.md', source)).rejects.toThrow('Quota');
    } finally { failOnce.mockRestore(); }
    const written = await readFile(attempt, workspace);
    expect(written).toContain('<strong>mot</strong>');
    expect((await repository.loadIndex()).pages).toEqual(initial.pages);
    await repository.importMarkdown(attempt, 'Guide.md', source);
    await repository.importMarkdown(attempt, 'Guide.md', source);
    expect(await readFile(attempt, workspace)).toBe(written);
    expect((await repository.loadIndex()).pages).toEqual([...initial.pages, {id: attempt, title: 'Guide', parentId: null}]);
  });
  it('keeps queued native writes on their original workspace and serializes them', async () => {
    const original = createLocalWorkspace('Original');
    const repository = workspaceRepository(original);
    const calls: Array<Record<string, unknown> | undefined> = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => { calls.push(args); if (calls.length === 1) await gate; });
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    const first = repository.writePage('page', 'first');
    const second = repository.writePage('page', 'second');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const originalId = original.id;
    original.id = 'changed-elsewhere';
    finish(); await first; await second;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.workspace).toBe(originalId);
    expect(calls[1]?.workspace).toBe(originalId);
  });
  it('rejects all local document I/O for a remote ref', async () => {
    const invoke = vi.fn(); Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    await expect(readFile('same',remote)).rejects.toThrow('forbidden');
    await expect(writeFile('same','secret',remote)).rejects.toThrow('forbidden');
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('scopes remote identity by server, account and workspace and stores no credential', () => {
    expect(workspaceKey(remote)).not.toBe(workspaceKey({...remote,accountId:'b'}));
    expect(workspaceKey(remote)).not.toBe(workspaceKey({...remote,server:'https://other.org'}));
    rememberWorkspace(remote);
    expect(localStorage.getItem('blok:desktop:workspaces:v1')).not.toContain('token');
  });
  it('ignores a delayed sidebar refresh after a newer local save was acknowledged', async () => {
    const page = { id: 'p', title: 'Before', parentId: null };
    const stale = { pages: [page], trash: [], revision: 1 };
    let resolveRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(stale))
      .mockReturnValueOnce(refresh)
      .mockResolvedValueOnce(Response.json({ revision: 2 }))
      .mockResolvedValueOnce(Response.json({ revision: 3 }));
    vi.stubGlobal('fetch', fetch);
    const repository = workspaceRepository(remote);
    const index = await repository.loadIndex();
    const poll = repository.refreshIndex(() => true);
    index.pages[0]!.title = 'After';
    await repository.saveIndex(index);
    resolveRefresh(Response.json(stale));
    expect(await poll).toBeNull();
    await repository.saveIndex(index);
    expect(JSON.parse(fetch.mock.calls[3]![1].body)).toMatchObject({ revision: 2, pages: [{ title: 'After' }] });
  });
  it('retries concurrent index writes without dropping remote pages on later local saves', async () => {
    const p = (id: string) => ({id,title:id,parentId:null});
    const responses = [
      {pages:[p('a')],trash:[],revision:1},
      null,
      {pages:[p('a'),p('remote')],trash:[],revision:2},
      {revision:3}, {revision:4},
    ];
    const fetch = vi.fn(async()=>{ const data=responses.shift(); return data === null ? {ok:false,status:409} : {ok:true,json:async()=>data}; }); vi.stubGlobal('fetch',fetch);
    const repository = workspaceRepository(remote);
    const index = await repository.loadIndex(); index.pages.push(p('local'));
    await repository.saveIndex(index);
    index.pages[0]!.title = 'Changed again';
    await repository.saveIndex(index);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[3]![1].body as string).pages.map((p:{id:string})=>p.id)).toEqual(['a','remote','local']);
    expect(JSON.parse(calls[4]![1].body as string).pages).toContainEqual(p('remote'));
    expect(()=>repository.writePage('id','data')).toThrow('collaboration');
  });
});

||||||| f8ef3c6b39

=======
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialWorkspace, createLocalWorkspace, rememberWorkspace, workspaceKey, type RemoteWorkspace } from './workspace-registry';
import { readFile, writeFile, loadIndex } from './storage';
import { workspaceRepository } from './workspace-repository';
const remote: RemoteWorkspace = { kind: 'remote', id: 'r', name: 'Shared', server: 'https://example.org', accountId: 'a', workspaceId: 'team' };
afterEach(() => { localStorage.clear(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.unstubAllGlobals(); });
describe('workspace isolation', () => {
  it('preserves the existing default data without migration and isolates new locals', async () => {
    localStorage.setItem('blok:workspace:index', JSON.stringify({pages:[{id:'old',title:'Existing',parentId:null}],activeId:'old'}));
    expect((await loadIndex(initialWorkspace)).activeId).toBe('old');
    const other = createLocalWorkspace('Other');
    await writeFile('old', 'new content', other);
    expect(await readFile('old', initialWorkspace)).toBeNull();
    expect(await readFile('old', other)).toBe('new content');
    expect((await loadIndex(initialWorkspace)).activeId).toBe('old');
  });
  it('keeps queued native writes on their original workspace and serializes them', async () => {
    const original = createLocalWorkspace('Original');
    const repository = workspaceRepository(original);
    const calls: Array<Record<string, unknown> | undefined> = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => { calls.push(args); if (calls.length === 1) await gate; });
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    const first = repository.writePage('page', 'first');
    const second = repository.writePage('page', 'second');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const originalId = original.id;
    original.id = 'changed-elsewhere';
    finish(); await first; await second;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.workspace).toBe(originalId);
    expect(calls[1]?.workspace).toBe(originalId);
  });
  it('rejects all local document I/O for a remote ref', async () => {
    const invoke = vi.fn(); Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    await expect(readFile('same',remote)).rejects.toThrow('forbidden');
    await expect(writeFile('same','secret',remote)).rejects.toThrow('forbidden');
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('scopes remote identity by server, account and workspace and stores no credential', () => {
    expect(workspaceKey(remote)).not.toBe(workspaceKey({...remote,accountId:'b'}));
    expect(workspaceKey(remote)).not.toBe(workspaceKey({...remote,server:'https://other.org'}));
    rememberWorkspace(remote);
    expect(localStorage.getItem('blok:desktop:workspaces:v1')).not.toContain('token');
  });
  it('retries concurrent index writes without dropping remote pages on later local saves', async () => {
    const p = (id: string) => ({id,title:id,parentId:null});
    const responses = [
      {pages:[p('a')],trash:[],revision:1},
      null,
      {pages:[p('a'),p('remote')],trash:[],revision:2},
      {revision:3}, {revision:4},
    ];
    const fetch = vi.fn(async()=>{ const data=responses.shift(); return data === null ? {ok:false,status:409} : {ok:true,json:async()=>data}; }); vi.stubGlobal('fetch',fetch);
    const repository = workspaceRepository(remote);
    const index = await repository.loadIndex(); index.pages.push(p('local'));
    await repository.saveIndex(index);
    index.pages[0]!.title = 'Changed again';
    await repository.saveIndex(index);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[3]![1].body as string).pages.map((p:{id:string})=>p.id)).toEqual(['a','remote','local']);
    expect(JSON.parse(calls[4]![1].body as string).pages).toContainEqual(p('remote'));
    expect(()=>repository.writePage('id','data')).toThrow('collaboration');
  });
});

>>>>>>> origin/fix/self-host-review