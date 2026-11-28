import type {PoolClient} from 'pg';
import {describeDatabases, parseDatabaseQuery, queryDatabase} from './database-reader.ts';
import {loadIndexPages,pageStandings} from './workspace-index.ts';
import {WorkspaceError} from './workspace-scope.ts';
import type {Role} from './page-level.ts';

export async function readWorkspaceDatabases(db:PoolClient, workspace:string, user:string, role:Role,
  action:'list'|'query', input:unknown) {
  const pages=await loadIndexPages(db,workspace,user);
  const access=pageStandings(pages,role);
  const ids=pages.filter(p=>!p.trashed && access[p.id]).map(p=>p.id);
  if (action==='list') {
    const {rows}=await db.query(`SELECT p.id,p.metadata->>'title' AS title,b
      FROM pages p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.content->'blocks')='array'
        THEN p.content->'blocks' ELSE '[]' END) b WHERE p.workspace_id=$1 AND p.id=ANY($2::text[])
      AND NOT p.deleted AND NOT p.trashed AND b->>'type'='database' ORDER BY p.id`,[workspace,ids]);
    return {databases:rows.flatMap(r=>describeDatabases(r.id,r.title ?? '',[r.b]))};
  }
  const q=parseDatabaseQuery(input);
  if (!ids.includes(q.page)) throw new WorkspaceError(404,'Base introuvable');
  const {rows:[p]}=await db.query('SELECT content,metadata FROM pages WHERE workspace_id=$1 AND id=$2 AND NOT deleted AND NOT trashed',[workspace,q.page]);
  const blocks=p?.content?.blocks;
  const info=describeDatabases(q.page,p?.metadata?.title || '',blocks).find(d=>d.id===q.database);
  if (!info) throw new WorkspaceError(404,'Base introuvable');
  return queryDatabase(info,blocks,q);
}
