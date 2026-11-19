import { expect, it, vi } from 'vitest';
import type { API, BlockAPI } from '../../types';
import { openRowRoute, rowRoutePath, openRowLocation } from './row-route';

function fixture() {
  const block = (id: string, name: string, parentId: string | null): BlockAPI => ({id,name,parentId,holder:document.createElement('div'),call:vi.fn()} as unknown as BlockAPI);
  const root=block('root','database',null), sprint=block('sprint','database-row','root'), tasks=block('tasks','database','sprint'), task=block('task','database-row','tasks');
  const all=[root,sprint,tasks,task];
  const blocks={getById:(id:string)=>all.find(block=>block.id===id)} as API['blocks'];
  return {root,sprint,tasks,task,blocks};
}

it('cancels a pending ancestor body mount when another route wins', async()=>{
  const {root,task,tasks,blocks}=fixture();
  const abort=new AbortController();
  const opened=openRowRoute(blocks,task,tasks,abort.signal);
  expect(root.call).toHaveBeenCalledWith('openRow',{rowId:'sprint',mode:'full',explicit:true});
  abort.abort();
  expect(await opened).toEqual([]);
  expect(tasks.call).not.toHaveBeenCalled();
});

it('refuses a broken or cyclic ancestry before opening any row',()=>{
  const {root,sprint,task,tasks,blocks}=fixture();
  Object.defineProperty(root,'parentId',{value:'task',configurable:true});
  expect(()=>rowRoutePath(blocks,task,tasks)).toThrow('Cycle');
  Object.defineProperty(root,'parentId',{value:'missing'});
  expect(()=>rowRoutePath(blocks,task,tasks)).toThrow('indisponible');
  expect(root.call).not.toHaveBeenCalled();
  expect(sprint.call).not.toHaveBeenCalled();
  expect(tasks.call).not.toHaveBeenCalled();
});

it('opens nested rows across five lazily mounted body documents', async () => {
  const levels = Array.from({length:5}, (_, i) => {
    const row = {id:`row${i}`,name:'database-row',parentId:`db${i}`,holder:document.createElement('div'),preservedData:{pageId:`doc${i+1}`},call:vi.fn()} as unknown as BlockAPI;
    const database = {id:`db${i}`,name:'database',parentId:null,holder:document.createElement('div'),call:vi.fn()} as unknown as BlockAPI;
    const byId = new Map([[row.id, row], [database.id, database]]);
    const blocks = {getById:(id:string) => byId.get(id)} as API['blocks'];
    return {row,database,blocks};
  });
  const active = new Map<string,{isReady:Promise<void>;blocks:API['blocks']}>();
  for (const [i, level] of levels.entries()) vi.mocked(level.database.call).mockImplementation(() => {
    const next = levels[i+1];
    if (next) active.set(`doc${i+1}`, {isReady:Promise.resolve(), blocks:next.blocks});
  });
  const first = levels[0]; if (!first) throw new Error('fixture');
  const steps = levels.map((level,i)=>({documentId:`doc${i}`,rowId:level.row.id,databaseId:level.database.id}));
  const opened = await openRowLocation('doc0',first.blocks,steps,id=>active.get(id),new AbortController().signal);
  expect(opened.map(step=>step.row.id)).toEqual(steps.map(step=>step.rowId));
  for (const level of levels) expect(level.database.call).toHaveBeenCalledExactlyOnceWith('openRow',{rowId:level.row.id,mode:'full',explicit:true});
});

it('cancels a missing body mount without opening the descendant', async () => {
  const {root,sprint,blocks}=fixture();
  Object.defineProperty(sprint,'preservedData',{value:{pageId:'body'}});
  const abort = new AbortController();
  const pending = openRowLocation('host',blocks,[{documentId:'host',rowId:sprint.id,databaseId:root.id},{documentId:'body',rowId:'inner',databaseId:'db'}],()=>undefined,abort.signal);
  await Promise.resolve();
  await Promise.resolve();
  abort.abort();
  expect(await pending).toEqual([]);
});

it('rejects a route that crosses into a document not owned by its previous row', async () => {
  const {root,sprint,blocks}=fixture();
  Object.defineProperty(sprint,'preservedData',{value:{pageId:'body'}});
  const lookup=vi.fn();
  await expect(openRowLocation('host',blocks,[{documentId:'host',rowId:sprint.id,databaseId:root.id},{documentId:'foreign',rowId:'inner',databaseId:'db'}],lookup,new AbortController().signal)).rejects.toThrow('parente');
  expect(lookup).not.toHaveBeenCalled();
});

it('discovers inline ancestors of an explicit target inside a separated body', async () => {
  const outer=fixture(), inner=fixture();
  Object.defineProperty(outer.sprint,'preservedData',{value:{pageId:'body'}});
  const holder=document.createElement('div'); holder.setAttribute('data-blok-database-drawer-editor',''); document.body.append(holder);
  vi.mocked(inner.root.call).mockImplementation(() => { holder.append(inner.sprint.holder); });
  const editor={isReady:Promise.resolve(),blocks:inner.blocks};
  try {
    const opened=await openRowLocation('host',outer.blocks,[
      {documentId:'host',rowId:'sprint',databaseId:'root'},
      {documentId:'body',rowId:'task',databaseId:'tasks'},
    ],()=>editor,new AbortController().signal);
    expect(opened.map(step=>[step.documentId,step.row.id])).toEqual([['host','sprint'],['body','sprint'],['body','task']]);
  } finally { holder.remove(); }
});

it('reports opened ancestors before awaiting a child mount so the host can close a cancelled route', async () => {
  const {root,sprint,blocks}=fixture();
  Object.defineProperty(sprint,'preservedData',{value:{pageId:'body'}});
  const abort=new AbortController(), progress=vi.fn();
  const pending=openRowLocation('host',blocks,[{documentId:'host',rowId:sprint.id,databaseId:root.id},{documentId:'body',rowId:'inner',databaseId:'db'}],()=>undefined,abort.signal,progress);
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(progress).toHaveBeenCalledWith([expect.objectContaining({row:sprint,documentId:'host'})]);
  } finally { abort.abort(); await pending; }
});
