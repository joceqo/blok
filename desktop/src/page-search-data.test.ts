import {expect, it} from 'vitest';
import {workspaceRepository} from './workspace-repository';

it('finds text and produces a plain-text preview only from visible disk pages', async () => {
  const ref = {kind:'local' as const, id:'palette', name:'Local'};
  const page = {id:'one',title:'Compte rendu',parentId:null};
  localStorage.setItem('blok:workspace:palette:one',JSON.stringify({blocks:[{id:'p',type:'paragraph',data:{text:'Prévoir le <b>budget</b> de jeudi.'}}]}));
  const search = workspaceRepository(ref).pageSearch(() => [page]);
  const signal = new AbortController().signal;
  expect(await search.preview('hidden',signal)).toBe('');
  expect(await search.preview('one',signal)).toContain('Prévoir le budget de jeudi.');
  expect(await search.searchContent('BUDGET',signal)).toEqual([{id:'one',excerpt:'Prévoir le budget de jeudi.'}]);
  await expect(search.searchContent('budget',AbortSignal.abort())).rejects.toThrow();
});
