import {afterEach,describe,expect,it,vi} from 'vitest';
import {pageNavigationUrl,libraryUrl,libraryCategoryForHref,pageDestination,publicPageUrl,resolvePageDestination,workspaceSwitchUrl,rememberPageLinks,pageIdForHref,copiedPageLink,rememberResolvedRowPage,forgetResolvedPages,rowPageDestination,rowPageUrl,restoredPageNavigationUrl} from './page-urls';
import type {CloudSession} from './cloud/client';
const uuid='2a7aee31-f541-41e8-9190-6eae552291b8';
it('preserves diagnostic opt-in during navigation without copying stale destinations or login parameters', () => {
  const destination = `https://example.org/p/sprints-${uuid}`;
  expect(pageNavigationUrl(destination, 'https://example.org/?page=old&profile=1&token=secret#old').href).toBe(`${destination}?profile=1`);
  expect(pageNavigationUrl(destination, 'https://example.org/?profile=0').href).toBe(destination);
  expect(publicPageUrl('https://example.org', 'sprints', uuid)).toBe(destination);
});
const workspace={id:'ws',slug:'new-workspace',name:'New name',role:'member' as const};
const session:CloudSession={user:{id:'user',email:'user@example.org'},workspaces:[workspace]};
afterEach(() => { rememberPageLinks(location.origin,location.origin,[]); forgetResolvedPages(location.origin); });
describe('stable public page URLs',()=>{
 it('opens a resolved body as its own document outside the sidebar index',()=>{
  const resolved={pageId:'body',publicId:uuid,title:'Task',workspace,teamspaceId:null,rowBodyOf:{documentId:'parent',rowId:'task'}};
  rememberResolvedRowPage(location.origin,resolved);
  rememberPageLinks(location.origin,location.origin,[{id:'parent',title:'Projects',publicId:'88888888-8888-8888-8888-888888888888'}]);
  expect(rowPageDestination(`${location.origin}/p/task-${uuid}`)).toBeNull();
  expect(rowPageDestination(`${location.origin}/?page=body`)).toBeNull();
  expect(pageIdForHref(`${location.origin}/p/task-${uuid}`)).toBe('body');
  expect(rowPageDestination(`https://foreign.example/p/task-${uuid}`)).toBeNull();
 });
 it('copies a native body link using its server identity after sidebar links have been refreshed', () => {
  rememberResolvedRowPage(location.origin, {pageId:'native-body',publicId:uuid,title:'Task',workspace,teamspaceId:null}, 'https://server.example');
  rememberPageLinks(location.origin, 'https://server.example', []);
  expect(copiedPageLink(`${location.origin}/?page=native-body`)).toBe(`https://server.example/p/task-${uuid}`);
  forgetResolvedPages(location.origin, workspace.id);
  expect(copiedPageLink(`${location.origin}/?page=native-body`)).toBe('blok://page/native-body');
 });
 it('keeps local body copies on the app deep link instead of inventing a public server page', () => {
  rememberResolvedRowPage(location.origin, {pageId:'local-body',publicId:uuid,title:'Local row',workspace,teamspaceId:null});
  expect(copiedPageLink(`${location.origin}/?page=local-body&local=1`)).toBe('blok://page/local-body');
 });
 it('gives rows without an independent body a reloadable parent route, and removes it on library/workspace navigation',()=>{
  const href=rowPageUrl('https://example.org/?page=parent&profile=1#old','task / 1','db');
  expect(rowPageDestination(href)).toEqual({documentId:'parent',rowId:'task / 1',databaseId:'db'});
  expect(restoredPageNavigationUrl(`https://example.org/p/parent-${uuid}`,href).href).toBe(`https://example.org/p/parent-${uuid}?profile=1&row=task+%2F+1&database=db`);
  expect(new URL(libraryUrl(href)).searchParams.has('row')).toBe(false);
  expect(new URL(workspaceSwitchUrl(href,false)).searchParams.has('row')).toBe(false);
 });
 it('parses the UUID independently of title and keeps legacy internal IDs intact',()=>{
  expect(pageDestination(`https://example.org/p/ancien-titre-${uuid}`)).toEqual({kind:'public',id:uuid});
  expect(pageDestination('https://example.org/?page=welcome-original-workspace')).toEqual({kind:'legacy',id:'welcome-original-workspace'});
  expect(pageDestination('https://example.org/p/page-inconnue')).toEqual({kind:'invalid'});
  expect(publicPageUrl('https://example.org','Équipe / Été 👩🏽‍💻',uuid)).toBe(`https://example.org/p/equipe-ete-${uuid}`);
 });
 it('resolves old page/workspace names through the authenticated identity, never through slug guesses',async()=>{
  const request=vi.fn(async(_path:string)=>({pageId:'welcome-original-workspace',publicId:uuid,title:'Titre renommé',workspace,teamspaceId:null}));
  const result=await resolvePageDestination({request} as Parameters<typeof resolvePageDestination>[0],'https://example.org/?page=welcome-original-workspace',session);
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/pages/resolve-id/welcome-original-workspace');
  expect(publicPageUrl('https://example.org',result.title,result.publicId)).toBe(`https://example.org/p/titre-renomme-${uuid}`);
  await resolvePageDestination({request} as Parameters<typeof resolvePageDestination>[0],`https://example.org/p/ancien-titre-${uuid}`,session);
  expect(request).toHaveBeenLastCalledWith(`/api/pages/resolve/${uuid}`);
 });
 it('does not open any fallback workspace for unavailable or foreign-membership pages',async()=>{
  const request=vi.fn(async()=>({pageId:'private',publicId:uuid,title:'Private',workspace:{...workspace,id:'other'},teamspaceId:null}));
  await expect(resolvePageDestination({request} as Parameters<typeof resolvePageDestination>[0],`https://example.org/p/page-${uuid}`,session)).rejects.toThrow('Page indisponible');
  request.mockRejectedValue(new Error('Not found'));
  await expect(resolvePageDestination({request} as Parameters<typeof resolvePageDestination>[0],`https://example.org/p/page-${uuid}`,session)).rejects.toThrow('Not found');
 });
 it('preserves a destination across login, but a deliberate workspace switch discards it',()=>{
  const href=`https://example.org/p/ancien-${uuid}?cloud=1&server=https://example.org`;
  expect(workspaceSwitchUrl(href,false,true)).toBe(`https://example.org/p/ancien-${uuid}`);
  expect(workspaceSwitchUrl(href,false)).toBe('https://example.org/');
  expect(workspaceSwitchUrl('https://example.org/?page=secret&cloud=1',true)).toBe('https://example.org/?local=1');
 });
 it('keeps copies and tab icons tied to the same page across renamed title routes, and isolates origins',()=>{
  rememberPageLinks(location.origin,'https://example.org',[{id:'internal',title:'New title',publicId:uuid}]);
  expect(pageIdForHref(`${location.origin}/p/old-title-${uuid}`)).toBe('internal');
  expect(copiedPageLink(`${location.origin}/?page=internal`)).toBe(`https://example.org/p/new-title-${uuid}`);
  expect(pageIdForHref(`https://other.example.org/p/old-title-${uuid}`)).toBeNull();
  rememberPageLinks(location.origin,'https://example.org',[]);
  expect(pageIdForHref(`${location.origin}/p/old-title-${uuid}`)).toBeNull();
  expect(copiedPageLink(`${location.origin}/?page=internal`)).toBe('blok://page/internal');
 });
});

describe('library routes', () => {
 it('drops public and legacy page destinations while preserving local workspace mode', () => {
  const href = libraryUrl(`https://example.org/p/old-${uuid}?page=stale&local=1#block`, 'favorite');
  expect(href).toBe('https://example.org/?local=1&library=favorite');
  expect(pageDestination(href)).toEqual({ kind: 'none' });
  expect(libraryCategoryForHref(href)).toBe('favorite');
 });
 it('restores categories from a fresh URL and defaults unknown categories safely', () => {
  expect(libraryCategoryForHref('https://example.org/?library=recent')).toBe('recent');
  expect(libraryCategoryForHref('https://example.org/?library=unknown')).toBe('all');
  expect(libraryCategoryForHref('https://example.org/?page=abc')).toBeNull();
  expect(workspaceSwitchUrl('https://example.org/?library=recent', false)).toBe('https://example.org/');
 });
});

it('routes an inline row inside a separated body through that body document on reload', () => {
  const publicId = '88888888-8888-4888-8888-888888888888';
  const resolved = {pageId:'body-nested', publicId, title:'Sprint', workspace:{id:'w',slug:'w',name:'W',role:'admin' as const},teamspaceId:null,
    rowBodyOf:{documentId:'host',rowId:'sprint'},
    location:{documentId:'host',blockId:'sprint',rows:[{documentId:'host',rowId:'sprint',databaseId:'sprints',title:'Sprint'}]}};
  rememberResolvedRowPage(location.origin, resolved);
  expect(rowPageDestination(`${location.origin}/p/sprint-${publicId}?row=task&database=tasks`)).toEqual({
    documentId:'body-nested',rowId:'task',databaseId:'tasks',
  });
});
