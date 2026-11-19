import { describe, expect, it } from 'vitest';
import { mergeWorkspaceIndex } from './workspace-merge';
import type { DesktopPage, WorkspaceIndex } from './storage';
const page = (id: string, values: Partial<DesktopPage> = {}): DesktopPage => ({id,title:id,parentId:null,...values});
const index = (...pages: DesktopPage[]): WorkspaceIndex => ({pages,trash:[],activeId:pages[0]?.id ?? ''});
describe('concurrent workspace metadata',()=>{
  it('allows a new child under a server-known hidden body and retains that access across writes', () => {
    const base = {...index(page('a')),access:{body:{level:'full' as const}}};
    const first = mergeWorkspaceIndex(base,index(page('a'),page('child1',{parentId:'body'})),base);
    expect(first.pages[1]?.parentId).toBe('body');
    const second = mergeWorkspaceIndex(first,index(...first.pages,page('child2',{parentId:'body'})),first);
    expect(second.pages[2]?.parentId).toBe('body');
    expect(second.access).toEqual(base.access);
    expect(() => mergeWorkspaceIndex(index(page('a')),index(page('a'),page('unknown',{parentId:'body'})),index(page('a')))).toThrow('concurrentes');
  });
  it('treats row locations as server projections, retaining fresh ancestry during metadata edits', () => {
    const location = {documentId:'a',blockId:'row',rows:[{documentId:'a',rowId:'row',databaseId:'db',title:'Sprint'}]};
    const base = index(page('a'), Object.assign(page('b',{parentId:'a'}), {location}));
    const local = index(page('a'), Object.assign(page('b',{parentId:'a',title:'Renamed'}), {location:{...location,blockId:'stale-client-value'}}));
    const remote = index(page('a'), Object.assign(page('b',{parentId:'a'}), {location:{...location,blockId:'row2'}}));
    expect(mergeWorkspaceIndex(base,local,remote).pages[1]).toMatchObject({title:'Renamed',location:{blockId:'row2'}});
  });
  it('does not reuse the old row location after an explicit page move', () => {
    const location = {documentId:'a',blockId:'row',rows:[{documentId:'a',rowId:'row',databaseId:'db',title:'Sprint'}]};
    const base = index(page('a'), Object.assign(page('b',{parentId:'a'}), {location}));
    const local = index(page('a'), page('b',{parentId:null}));
    expect(mergeWorkspaceIndex(base,local,base).pages[1]).toEqual(page('b',{parentId:null}));
  });
  it('accepts an unchanged hidden body storage parent through its server location', () => {
    const location = {documentId:'a',blockId:'row',rows:[{documentId:'a',rowId:'row',databaseId:'db',title:'Sprint'}]};
    const base = index(page('a'), Object.assign(page('b',{parentId:'hidden-body'}), {location}));
    const local = structuredClone(base);
    const child=local.pages[1]; if (!child) throw new Error('Missing child'); child.title='Renamed';
    expect(mergeWorkspaceIndex(base,local,base).pages[1]).toMatchObject({title:'Renamed',parentId:'hidden-body'});
  });
  it('keeps independently created pages from both writers',()=>{
    const merged=mergeWorkspaceIndex(index(page('a')),index(page('a'),page('mine')),index(page('a'),page('theirs')));
    expect(merged.pages.map(p=>p.id)).toEqual(['a','theirs','mine']);
  });
  it('retains a pure local reorder and ignores server-derived positions',()=>{
    const base=index(page('a'),page('b'),page('c'),page('d'));
    const local=index(page('b'),page('d'),page('a'),page('c'));
    const remote=index(...base.pages.map((p,i)=>({...p,position:i})));
    expect(mergeWorkspaceIndex(base,local,remote).pages.map(p=>p.id)).toEqual(['b','d','a','c']);
  });
  it('preserves concurrent insertions when a local reorder does not overlap them',()=>{
    const base=index(page('a'),page('b'),page('c'));
    const local=index(page('b'),page('a'),page('c'));
    const remote=index(page('x'),page('a'),page('b'),page('c'));
    expect(mergeWorkspaceIndex(base,local,remote).pages.map(p=>p.id)).toEqual(['x','b','a','c']);
  });
  it('rejects overlapping reorder and insertion constraints',()=>{
    expect(()=>mergeWorkspaceIndex(index(page('a'),page('b')),index(page('b'),page('a')),index(page('a'),page('x'),page('b')))).toThrow('concurrentes');
  });
  it('merges different fields on the same page',()=>{
    const merged=mergeWorkspaceIndex(index(page('a')),index(page('a',{title:'Mine'})),index(page('a',{cover:'dusk'})));
    expect(merged.pages[0]).toMatchObject({title:'Mine',cover:'dusk'});
  });
  it('rejects overlapping title changes',()=>{
    expect(()=>mergeWorkspaceIndex(index(page('a')),index(page('a',{title:'Mine'})),index(page('a',{title:'Theirs'})))).toThrow('concurrentes');
  });
  it('preserves remote deletion when local did not edit the deleted page',()=>{
    expect(mergeWorkspaceIndex(index(page('a'),page('b')),index(page('a'),page('b',{title:'Mine'})),index(page('b'))).pages).toEqual([page('b',{title:'Mine'})]);
  });
  it.each(['delete-local','delete-remote'])('rejects deletion versus concurrent edits: %s',(direction)=>{
    const base=index(page('a'),page('b'));
    const deleted={...index(page('b')),trash:[page('a')]};
    const edited=index(page('a',{title:'Edited'}),page('b'));
    expect(()=>mergeWorkspaceIndex(base,direction==='delete-local'?deleted:edited,direction==='delete-local'?edited:deleted)).toThrow('concurrentes');
  });
});
