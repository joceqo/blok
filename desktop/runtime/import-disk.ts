import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool } from '../../apps/service-node/src/db/pool.ts';
import { inTransaction } from '../../apps/service-node/src/shell/bootstrap.ts';
import { calendarInput } from '../../apps/service-node/src/shell/calendar.ts';
import { parseIndex } from '../../apps/service-node/src/shell/index-save.ts';
import { normalizeLegacyDocument } from './legacy-document.ts';

const source = 'default';
const calendarFile = 'workspace-calendar-v1.json';
const registryFile = 'row-bodies.json';
const indexFile = 'index.json';
const digest = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
type Json = Record<string, unknown>;
function obj(x: unknown): x is Json { return !!x && typeof x === 'object' && !Array.isArray(x); }
interface Original { name:string; bytes:Buffer; hash:string; }
interface ImportedPage { meta:Json & {id:string;title:string;parentId?:string|null}; trashed:boolean; content:Json|null; }
const fail = (reason:string) => new Error('Migration du dossier local interrompue : ' + reason + '. Les fichiers sur disque sont conservés.');

async function names(directory:string) {
  const entries = await readdir(directory,{withFileTypes:true});
  return entries.filter(entry => entry.name !== '.DS_Store').map(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw fail('le dossier contient un fichier non reconnu');
    return entry.name;
  }).sort();
}

async function readOriginal(directory:string, name:string): Promise<Original> {
  const file = await open(join(directory,name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw fail('un fichier a changé pendant la lecture');
    const bytes = await file.readFile();
    return {name, bytes, hash:digest(bytes)};
  } finally { await file.close(); }
}
function json(file:Original): unknown {
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)); }
  catch { throw fail('un fichier JSON est illisible'); }
}

export async function readLegacyWorkspace(directory:string) {
  const stat = await lstat(directory).catch(error=>{if(error.code!=='ENOENT') throw error; return null;});
  if (!stat) return;
  if (!stat.isDirectory()) throw fail('la source doit être un répertoire');
  const paths = await names(directory);
  if (!paths.length) return;
  if (!paths.includes(indexFile)) throw fail('index.json manque');
  const files = new Map<string,Original>();
  for (const path of paths) files.set(path,await readOriginal(directory,path));
  const index=json(files.get(indexFile)!);
  if (!obj(index)) throw fail('index de pages invalide');
  const {incoming} = parseIndex({...index,revision:0});
  const used = new Set([indexFile,registryFile,calendarFile]);
  const pages:ImportedPage[]=[];
  const byId=new Map<string,ImportedPage>();
  const document = (name:string):Json|null => {
    const file=files.get(name);
    if (!file) return null; // The disk editor permits an indexed page to have no saved body yet.
    const data=json(file);
    if (!obj(data) || !Array.isArray(data.blocks)) throw fail('corps de document invalide');
    return normalizeLegacyDocument(data);
  };
  for (const page of incoming) {
    const filename=page.meta.id+'.json';
    if (used.has(filename)) throw fail('identifiant de page réservé ou dupliqué');
    used.add(filename);
    const entry={...page,content:document(filename)};
    byId.set(page.meta.id,entry); pages.push(entry);
  }
  const registry=files.has(registryFile) ? json(files.get(registryFile)!) : {};
  if (!obj(registry)) throw fail('registre de fiches invalide');
  let rowPages=0, recovered=0;
  for (const [id,row] of Object.entries(registry)) {
    if (!obj(row) || typeof row.documentId!=='string' || typeof row.title!=='string') throw fail('fiche de base de données invalide');
    const parent=byId.get(row.documentId);
    if (!parent) throw fail('page parente de fiche absente');
    if (byId.has(id)) continue;
    const filename=id+'.json';
    if (used.has(filename)) throw fail('identifiant de fiche réservé');
    used.add(filename);
    const meta={id,title:row.title,parentId:row.documentId,...(typeof row.icon==='string'?{icon:row.icon}:{})};
    const page={meta,trashed:parent.trashed,content:document(filename)};
    pages.push(page); byId.set(id,page); rowPages++;
  }
  for (const name of paths) {
    if (used.has(name)) continue;
    const content=document(name);
    const id=name.slice(0,-5);
    pages.push({meta:{id,title:typeof content?.title==='string' ? content.title : 'Page récupérée',parentId:null,
      initialVisibility:'private',trashRoot:true}, trashed:true, content});
    recovered++;
  }
  // Validate generated row/recovery metadata against the normal server index, too.
  parseIndex({revision:0,pages:pages.filter(p=>!p.trashed).map(p=>p.meta),trash:pages.filter(p=>p.trashed).map(p=>p.meta)});
  const active=typeof index.activeId==='string' && !byId.get(index.activeId)?.trashed && byId.has(index.activeId) ? index.activeId : null;
  const rawEvents=files.has(calendarFile) ? json(files.get(calendarFile)!) : [];
  if (!Array.isArray(rawEvents)) throw fail('fichier calendrier invalide');
  const events=rawEvents.map(value=>{
    if (!obj(value) || typeof value.id!=='string') throw fail('événement invalide');
    return calendarInput(value.id,value);
  });
  const counts={files:files.size,indexedPages:incoming.filter(p=>!p.trashed).length,trashed:incoming.filter(p=>p.trashed).length,
    rowPages,recovered,events:events.length};
  return {files,pages,active,events,counts};
}

/** Execute after creating the device identity and before opening the loopback gateway. */
export async function migrateLegacyWorkspace(directory:string, databaseUrl:string) {
  const db=createPool(databaseUrl);
  try {
    return await inTransaction(db,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(774839104)');
      if ((await client.query('SELECT FROM desktop_disk_imports WHERE source=$1',[source])).rowCount) return;
      const input=await readLegacyWorkspace(directory);
      if (!input) return;
      const {rows:[device]}=await client.query<{user_id:string;workspace_id:string}>(
        'SELECT user_id,workspace_id FROM desktop_device_account WHERE singleton FOR UPDATE');
      if (!device?.workspace_id) throw fail('compte de cet appareil absent');
      let target=device.workspace_id;
      const {rows:[workspace]}=await client.query('SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE',[target]);
      const exists=await client.query(`SELECT FROM pages WHERE workspace_id=$1 UNION ALL
        SELECT FROM workspace_calendar_events WHERE workspace_id=$1 LIMIT 1`,[target]);
      if (Number(workspace.revision)!==0 || exists.rowCount) {
        // Keep a workspace already edited in Node intact. The import gets its own library.
        target=randomUUID();
        await client.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Espace importé')",[target,'disque-'+target]);
        await client.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[target,device.user_id]);
      }
      const conflict=await client.query('SELECT FROM pages WHERE id=ANY($1::text[]) LIMIT 1',[input.pages.map(p=>p.meta.id)]);
      if (conflict.rowCount) throw fail('un identifiant de page appartient déjà à la base');
      for (const [position,page] of input.pages.entries()) {
        const m=page.meta;
        const visibility=m.initialVisibility==='private'?'private':m.parentId?'inherit':'workspace';
        await client.query('INSERT INTO pages(id,workspace_id,metadata,trashed,visibility,content) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb)',
          [m.id,target,JSON.stringify({...m,position}),page.trashed,visibility,page.content && JSON.stringify(page.content)]);
        if (visibility==='private') await client.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,'full',$2)",[m.id,device.user_id]);
      }
      for (const e of input.events) await client.query(`INSERT INTO workspace_calendar_events
        (workspace_id,id,title,starts_at,ends_at,all_day,page_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [target,e.id,e.title,e.start,e.end,e.allDay,e.pageId,e.revision || 1]);
      await client.query('UPDATE workspaces SET revision=revision+1 WHERE id=$1',[target]);
      await client.query('INSERT INTO desktop_disk_imports(source,workspace_id,active_page_id,counts) VALUES($1,$2,$3,$4::jsonb)',
        [source,target,input.active,JSON.stringify(input.counts)]);
      for (const original of input.files.values()) {
        await client.query('INSERT INTO desktop_disk_originals(source,filename,sha256,bytes) VALUES($1,$2,$3,$4)',
          [source,original.name,original.hash,original.bytes]);
      }
      const finalNames=await names(directory);
      if (finalNames.length!==input.files.size) throw fail('le dossier source a changé pendant la migration');
      for (const name of finalNames) {
        const file=await readOriginal(directory,name);
        if (input.files.get(name)?.hash!==file.hash) throw fail('le dossier source a changé pendant la migration');
      }
      return input.counts;
    });
  } finally { await db.end(); }
}
