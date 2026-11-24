import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { documentAccess } from './room-tickets.ts';
import { loadIndexPages, workspaceIndex } from './workspace-index.ts';
import { removeAssetFile } from './asset-storage.ts';
import { storeWorkspaceImage } from './workspace-media.ts';
import { WorkspaceError } from './workspace-scope.ts';
import type { Role } from './page-level.ts';

interface ToolResult { isError?: boolean; content: {type:'text';text:string}[] }
export interface HostedMcpOptions {
  syncUrl: string;
  origin: string;
  ticketSecret: string;
  authorize(principal: string, doc: string, write: boolean): Promise<boolean>;
  call(principal: string, name: string, args: Record<string,unknown>): Promise<ToolResult>;
}
interface Runtime {
  fetch(request: Request,principal: string,owner: string): Promise<Response>;
  close(): Promise<void>;
}
interface HostedMcpModule { hostedMcp(options: HostedMcpOptions): Runtime }
const text = (value: unknown): ToolResult => ({content:[{type:'text',text:JSON.stringify(value)}]});
const denied = (message: string): ToolResult => ({isError:true,content:[{type:'text',text:message}]});

export function mcpBackend(pool: PgPool) {
  async function authorize(principal: string, doc: string, write: boolean) {
    if (!/^mcp:[a-f0-9]{64}$/.test(principal)) return false;
    const access = await documentAccess(pool,principal,doc);
    if (write ? !access.write : !access.read) return false;
    // Opening the document seals the seed route, as for a human editor.
    await pool.query('UPDATE pages SET admission_started=true WHERE id=$1 AND NOT deleted AND NOT trashed AND NOT admission_started',[doc]);
    return true;
  }
  async function call(principal: string, name: string, args: Record<string,unknown>): Promise<ToolResult> {
    if (!/^mcp:[a-f0-9]{64}$/.test(principal)) return denied('Invalid token');
    const db = await pool.connect();
    let committed = false;
    let uploaded: string | undefined;
    try {
      await db.query('BEGIN');
      const {rows:[account]} = await db.query<{user_id:string}>('SELECT user_id FROM mcp_tokens WHERE id=$1 AND expires_at>now() FOR SHARE',[principal.slice(4)]);
      if (!account) return denied('Invalid or expired token');
      if (name === 'blok_list_workspaces') {
        const {rows} = await db.query(`SELECT w.id,w.slug,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
          WHERE m.user_id=$1 ORDER BY w.name,w.id`,[account.user_id]);
        return text({workspaces:rows});
      }
      if (typeof args.workspace !== 'string') return denied('Workspace unavailable');
      const write = name === 'blok_create_page' || name === 'blok_upload_image';
      const {rows:[ws]} = await db.query<{id:string;slug:string;revision:string;role:Role}>(`SELECT w.id,w.slug,w.revision,m.role
        FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.slug=$1 AND m.user_id=$2
        ${write ? 'FOR UPDATE OF w FOR SHARE OF m' : ''}`,[args.workspace,account.user_id]);
      if (!ws) return denied('Workspace unavailable');
      if (name === 'blok_list_pages') {
        const pages = await loadIndexPages(db,ws.id,account.user_id);
        return text({pages:workspaceIndex(pages,ws.role,Number(ws.revision)).pages});
      }
      if (ws.role === 'viewer') return denied('Write access required');
      if (name === 'blok_upload_image') {
        if (typeof args.dataUrl !== 'string') return denied('Image required');
        const url = await storeWorkspaceImage(db,ws.id,args.dataUrl);
        uploaded = url.slice('/files/'.length);
        await db.query('COMMIT');
        committed = true;
        return text({url});
      }
      if (name !== 'blok_create_page') return denied('Unknown workspace tool');
      if (typeof args.title !== 'string' || !args.title || Buffer.byteLength(args.title)>4096) return denied('Invalid page title');
      const parentId = args.parentId || null;
      if (parentId !== null) {
        if (typeof parentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(parentId) ||
            !(await documentAccess(db,principal,parentId,ws.slug)).write) return denied('Parent page unavailable');
      }
      const position = await db.query('SELECT count(*)::int AS n FROM pages WHERE workspace_id=$1 AND NOT deleted AND NOT trashed',[ws.id]);
      const id = randomUUID();
      const metadata = {id,title:args.title,parentId,position:position.rows[0].n};
      await db.query(`INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES($1,$2,$3,'{"blocks":[]}', $4)`,
        [id,ws.id,metadata,parentId ? 'inherit' : 'workspace']);
      await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,'full',$2)",[id,account.user_id]);
      const {rows:[revision]} = await db.query('UPDATE workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision',[ws.id]);
      await db.query('COMMIT');
      committed = true;
      return text({id,title:args.title,workspace:ws.slug,revision:Number(revision.revision)});
    } catch (error) {
      if (error instanceof WorkspaceError) return denied(error.message);
      throw error;
    } finally {
      try {
        if (!committed) {
          await db.query('ROLLBACK');
          if (uploaded && !(await db.query('SELECT 1 FROM assets WHERE name=$1', [uploaded])).rowCount)
            await removeAssetFile(uploaded);
        }
      } finally { db.release(); }
    }
  }
  return {authorize,call};
}

export function createHostedMcp(pool: PgPool) {
  const app = new Hono();
  let runtime: Promise<Runtime> | undefined;
  app.use('*',bodyLimit({maxSize:8<<20,onError:c => c.json({error:'Request too large'},413)}));
  app.all('/',async c => {
    const bearer = c.req.header('Authorization');
    if (c.req.header('Origin') !== undefined || !bearer?.startsWith('Bearer ') || bearer.length <= 7)
      return c.json({error:'Bearer token required'},401);
    const digest = createHash('sha256').update(bearer.slice(7)).digest('hex');
    const {rows:[token]} = await pool.query<{user_id:string}>('UPDATE mcp_tokens SET last_used_at=now() WHERE id=$1 AND expires_at>now() RETURNING user_id',[digest]);
    if (!token) return c.json({error:'Invalid or expired token'},401);
    const secret = process.env.TICKET_SECRET, origin = process.env.PUBLIC_URL;
    if (!secret || !origin) return c.json({error:'MCP transport configuration unavailable'},503);
    if (!runtime) {
      // The editor command engine and protocol SDK share one runtime across stateless HTTP requests.
      const url = new URL('../../dist/shell/mcp-runtime.mjs',import.meta.url);
      runtime = (import(url.href) as Promise<HostedMcpModule>)
        .then(mod => mod.hostedMcp({...mcpBackend(pool),ticketSecret:secret,origin:new URL(origin).origin,
          syncUrl:process.env.MCP_SYNC_URL || 'ws://room:18102/api/blok/sync'}))
        .catch(error => { runtime = undefined; throw error; });
    }
    return (await runtime).fetch(c.req.raw,'mcp:'+digest, token.user_id);
  });
  return app;
}
