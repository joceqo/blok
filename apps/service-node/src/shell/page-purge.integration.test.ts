import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../auth/codes.ts';
import { pagePurgeRoutes, finishPagePurge, startPurgeRetries } from './page-purge.ts';
import { WorkspaceError } from './workspace-scope.ts';
import { saveProjection } from './projection.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('Permanent deletion of a canonical page', () => {
  const schema = 'purge_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url }),
    db = new pg.Pool({ connectionString: url, options: '-csearch_path=' + schema });
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
    await db.query("INSERT INTO workspaces(id,slug,name) VALUES ('w','ws','Workspace')");
    for (const [id, role] of [
      ['owner', 'admin'],
      ['author', 'member'],
      ['reader', 'viewer'],
    ]) {
      await db.query("INSERT INTO users(id,email) VALUES($1,$1||'@example.test')", [id]);
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [
        hashSecret(id!),
        id,
      ]);
      await db.query("INSERT INTO memberships VALUES('w',$1,$2)", [id, role]);
    }
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,content,visibility,trashed) VALUES
      ('private','w','{"title":"Confidentiel"}','{"blocks":[]}','private',true),
      ('live','w','{}','{"blocks":[]}','workspace',false),('parent','w','{}',null,'workspace',true),
      ('child','w','{"parentId":"parent"}',null,'inherit',true)`);
    await db.query(
      "INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('private','author','full','author')",
    );
  });
  afterAll(async () => {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  it('authorizes before enqueuing, persists failure and finishes once after restarting the worker', async () => {
    const room = vi.fn<(_: string) => Promise<void>>().mockRejectedValue(new Error('Unavailable'));
    const app = new Hono();
    app.onError((error, c) =>
      error instanceof HTTPException || error instanceof WorkspaceError
        ? c.json({}, error.status)
        : c.json({}, 500),
    );
    app.route('/', pagePurgeRoutes(db, room));
    const remove = (user: string, id: string) =>
      app.request('/api/workspaces/ws/pages/' + id + '/purge', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + user },
      });
    expect((await remove('reader', 'private')).status).toBe(403);
    expect((await remove('owner', 'private')).status).toBe(404);
    expect((await remove('owner', 'live')).status).toBe(409);
    expect((await remove('author', 'parent')).status).toBe(403);
    expect((await remove('owner', 'parent')).status).toBe(409);
    expect(room).not.toHaveBeenCalled();
    expect((await remove('author', 'private')).status).toBe(202);
    expect(
      await saveProjection(db, 'private', '{"blocks":[]}', { version: '0', lineage: 'x', sequence: '1' }),
    ).toBeUndefined();
    expect((await remove('author', 'private')).status).toBe(202);
    expect(room).toHaveBeenCalledTimes(1);
    await db.query("UPDATE page_purge_requests SET next_attempt_at=now() WHERE page_id='private'");
    room.mockResolvedValue(undefined);
    const stop = startPurgeRetries(db, room);
    await stop();
    expect(await finishPagePurge(db, 'private', room)).toBe(true);
    expect((await remove('author', 'private')).status).toBe(200);
    expect(room).toHaveBeenCalledTimes(2);
    expect(
      (await db.query("SELECT deleted,content,metadata,lineage,sequence FROM pages WHERE id='private'"))
        .rows[0],
    ).toEqual({ deleted: true, content: null, metadata: {}, lineage: null, sequence: null });
    expect((await db.query("SELECT FROM page_shares WHERE page_id='private'")).rowCount).toBe(0);
    expect((await db.query("SELECT revision FROM workspaces WHERE id='w'")).rows[0].revision).toBe('1');
  });
});
