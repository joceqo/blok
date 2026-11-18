import type { CloudClient, CloudSession, CloudWorkspace } from './cloud/client';
export type PageDestination = {kind:'public';id:string}|{kind:'legacy';id:string}|{kind:'invalid'}|{kind:'none'};
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const isPublicPageId=(value:string):boolean=>new RegExp(`^${UUID}$`,'i').test(value);
export function pageDestination(href:string):PageDestination {
  const url=new URL(href,location.href);
  if(url.pathname==='/p' || url.pathname.startsWith('/p/')){
    const match=new RegExp(`^/p/(?:[^/]*-)?(${UUID})/?$`,'i').exec(url.pathname);
    return match ? {kind:'public',id:match[1].toLowerCase()} : {kind:'invalid'};
  }
  if(url.searchParams.has('page')) {const id=url.searchParams.get('page');return id ? {kind:'legacy',id} : {kind:'invalid'};}
  return {kind:'none'};
}
export function publicPageUrl(server:string,title:string,publicId:string):string {
  if(!isPublicPageId(publicId))throw new Error('Identité publique de page invalide.');
  const slug=title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,100).replace(/-$/,'') || 'page';
  return new URL(`/p/${slug}-${publicId.toLowerCase()}`,server).href;
}
export function legacyPageUrl(base:string,id:string):string {const url=new URL('/',base);url.searchParams.set('page',id);return url.href;}

/** Navigation keeps opt-in diagnostics; copied/shared canonical links stay clean. */
export function pageNavigationUrl(destination: string, currentHref = location.href): URL {
  const url = new URL(destination, currentHref);
  if (new URL(currentHref).searchParams.get('profile') === '1') url.searchParams.set('profile', '1');
  return url;
}
export interface ResolvedPage {pageId:string;publicId:string;title:string;workspace:CloudWorkspace;teamspaceId:string|null;rowBodyOf?:{documentId:string;rowId:string}}
export interface RowPageDestination {documentId:string;rowId:string;databaseId?:string;pageId?:string}
// Resolver context is transient. Internal row bodies never become sidebar pages.
const resolvedRows=new Map<string,RowPageDestination>();
export function rememberResolvedRowPage(origin:string,page:ResolvedPage):void {
  const keys=[`${origin}|public|${page.publicId.toLowerCase()}`,`${origin}|legacy|${page.pageId}`];
  for(const key of keys){
    if(page.rowBodyOf)resolvedRows.set(key,{...page.rowBodyOf,pageId:page.pageId});
    else resolvedRows.delete(key);
  }
}
export function rowPageDestination(href:string):RowPageDestination|null {
  const url=new URL(href,location.href),destination=pageDestination(url.href);
  if(destination.kind==='public' || destination.kind==='legacy'){
    const resolved=resolvedRows.get(`${url.origin}|${destination.kind}|${destination.id}`);
    if(resolved)return {...resolved};
  }
  const rowId=url.searchParams.get('row'),documentId=pageIdForHref(url.href);
  if(!rowId || !documentId)return null;
  const databaseId=url.searchParams.get('database');
  return {documentId,rowId,...(databaseId ? {databaseId} : {})};
}
/** Inline and unmigrated rows stay addressable through their source page. */
export function rowPageUrl(parentUrl:string,rowId:string,databaseId?:string):string {
  const url=new URL(parentUrl,location.href);
  url.hash='';url.searchParams.set('row',rowId);
  if(databaseId)url.searchParams.set('database',databaseId);else url.searchParams.delete('database');
  return url.href;
}
/** Boot canonicalizes the page identity while retaining a requested row. */
export function restoredPageNavigationUrl(destination:string,currentHref=location.href):URL {
  const url=pageNavigationUrl(destination,currentHref),current=new URL(currentHref);
  for(const key of ['row','database']){const value=current.searchParams.get(key);if(value)url.searchParams.set(key,value);}
  url.hash=current.hash;
  return url;
}
export async function resolvePageDestination(client:Pick<CloudClient,'request'>,href:string,session:CloudSession):Promise<ResolvedPage> {
  const destination=pageDestination(href);
  if(destination.kind==='invalid' || destination.kind==='none')throw new Error('Page indisponible.');
  const route=destination.kind==='public' ? 'resolve' : 'resolve-id';
  const result=await client.request<ResolvedPage>(`/api/pages/${route}/${encodeURIComponent(destination.id)}`);
  if((destination.kind==='public' && result.publicId.toLowerCase()!==destination.id) || (destination.kind==='legacy' && result.pageId!==destination.id) || !isPublicPageId(result.publicId) || !session.workspaces.some(workspace=>workspace.id===result.workspace.id && workspace.slug===result.workspace.slug))throw new Error('Page indisponible.');
  return result;
}
const pageLinks=new Map<string,{id:string;publicId:string;href:string}>();
export function rememberPageLinks(origin:string,server:string,pages:{id:string;title:string;publicId?:string}[]):void {
  for(const key of pageLinks.keys())if(key.startsWith(`${origin}|`))pageLinks.delete(key);
  pages.forEach(page=>{if(page.publicId && isPublicPageId(page.publicId))pageLinks.set(`${origin}|${page.id}`,{id:page.id,publicId:page.publicId,href:publicPageUrl(server,page.title,page.publicId)});});
}
export function pageIdForHref(href:string):string|null {
  try {
    const url=new URL(href,location.href),destination=pageDestination(url.href);
    if(destination.kind==='legacy')return destination.id;
    if(destination.kind!=='public')return null;
    return [...pageLinks.entries()].find(([key,value])=>key.startsWith(`${url.origin}|`) && value.publicId===destination.id)?.[1].id ?? null;
  }catch{return null;}
}
export function copiedPageLink(href:string):string|null {
  try {
    const url=new URL(href,location.href),destination=pageDestination(url.href);
    if(destination.kind==='public')return url.href;
    if(destination.kind!=='legacy')return null;
    return pageLinks.get(`${url.origin}|${destination.id}`)?.href ?? `blok://page/${destination.id}`;
  }catch{return null;}
}
/** A voluntary switch drops the destination; only an explicit login continuation retains it. */
export function workspaceSwitchUrl(href:string,local:boolean,resumePage=false):string {
  const url=new URL(href);
  if(!resumePage){url.pathname='/';for(const key of ['page','library','row','database'])url.searchParams.delete(key);url.hash='';}
  for(const key of ['cloud','manage','section','server'])url.searchParams.delete(key);
  if(local)url.searchParams.set('local','1');else url.searchParams.delete('local');
  return url.href;
}

export type LibraryCategory = 'all' | 'teamspaces' | 'recent' | 'favorite' | 'shared' | 'private';
export function libraryCategoryForHref(href: string): LibraryCategory | null {
  const value = new URL(href, location.href).searchParams.get('library');
  if (value === null) return null;
  return ['teamspaces', 'recent', 'favorite', 'shared', 'private'].includes(value) ? value as LibraryCategory : 'all';
}
export function libraryUrl(href: string, category: LibraryCategory = 'all'): string {
  const url = new URL(href, location.href);
  url.pathname = '/'; url.hash = ''; for(const key of ['page','row','database'])url.searchParams.delete(key);
  url.searchParams.set('library', category);
  return url.href;
}
