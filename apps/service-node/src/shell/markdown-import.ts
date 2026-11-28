import {createHash} from 'node:crypto';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {HTTPException} from 'hono/http-exception';
import type {PgPool} from '../db/pool.ts';
import {inTransaction} from './bootstrap.ts';
import {sessionDigest} from './session.ts';
import {readWorkspaceScope} from './workspace-scope.ts';

type MarkdownRuntime = {
  prepareDocument(name: string, source: string): Promise<{title: string; icon?: {type: string; value?: string}; blocks: unknown[]}>;
};

function importPageId(identity: string): string {
  // UUIDv8 using the first 122 bits of the request's SHA-256 digest.
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

export function markdownImportRoutes(pool: PgPool) {
  const router = new Hono();
  router.post('/api/workspaces/:slug/import/markdown', bodyLimit({maxSize: 8 << 20}), async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.attempt !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.attempt) ||
        typeof body.name !== 'string' || body.name.length > 1024 || !/\.(md|markdown)$/i.test(body.name) ||
        typeof body.source !== 'string') throw new HTTPException(400, {message:'Invalid Markdown file'});
    const key = sessionDigest(c) ?? '';
    const slug = c.req.param('slug');
    const {id} = await inTransaction(pool, async db => {
      const scope = await readWorkspaceScope(db, key, slug, true);
      if (scope.role === 'viewer') throw new HTTPException(403, {message:'Write access required'});
      const identity = JSON.stringify([scope.workspace_id, scope.user_id, body.attempt, body.name, body.source]);
      const id = importPageId(identity);
      const existing = await db.query(
        `SELECT p.id FROM pages p JOIN page_shares s ON s.page_id=p.id
         WHERE p.id=$1 AND p.workspace_id=$2 AND s.user_id=$3 AND s.level='full' AND NOT p.trashed AND NOT p.deleted`,
        [id, scope.workspace_id, scope.user_id]);
      if (existing.rowCount) return {id};

      const url = new URL('../../dist/shell/markdown-runtime.mjs', import.meta.url);
      const runtime: MarkdownRuntime = await import(url.href);
      let document;
      try { document = await runtime.prepareDocument(body.name, body.source); }
      catch { throw new HTTPException(422, {message:'Markdown could not be converted to a Blok page'}); }
      if (Buffer.byteLength(document.title) > 4096) throw new HTTPException(400, {message:'Page title too long'});
      const metadata = {id, title: document.title, parentId: null, ...(document.icon?.type === 'emoji' ? {icon: document.icon.value} : {})};
      const added = await db.query(
        `INSERT INTO pages(id,workspace_id,metadata,content,visibility)
         VALUES($1,$2,$3::jsonb || jsonb_build_object('position',(SELECT count(*) FROM pages WHERE workspace_id=$2)),$4,'private')
         ON CONFLICT(id) DO NOTHING`, [id,scope.workspace_id,JSON.stringify(metadata),JSON.stringify(document)]);
      if (!added.rowCount) throw new HTTPException(409, {message:'Page no longer available'});
      await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,'full',$2)", [id, scope.user_id]);
      await db.query('UPDATE workspaces SET revision=revision+1 WHERE id=$1', [scope.workspace_id]);
      return {id};
    });
    return c.json({id});
  });
  return router;
}
