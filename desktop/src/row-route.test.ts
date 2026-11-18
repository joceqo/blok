import { expect, it, vi } from 'vitest';
import type { API, BlockAPI } from '../../types';
import { openRowRoute, rowRoutePath } from './row-route';

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
