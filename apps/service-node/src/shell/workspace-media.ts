import { randomBytes } from 'node:crypto';
import { mediaOrigin, writeImage, removeAssetFile } from './asset-storage.ts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { sessionDigest } from './session.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

const imageLimit = 5 << 20;
const emojiLimit = 2 << 20;

function imageExtension(bytes: Buffer): [string, string] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return ['png', 'png'];
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return ['jpeg', 'jpg'];
  const signature = bytes.toString('latin1', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') return ['gif', 'gif'];
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 15) === 'WEBPVP8')
    return ['webp', 'webp'];
}

export function decodeWorkspaceImage(raw: string, limit = imageLimit) {
  const invalid = () =>
    new WorkspaceError(400, 'Use a PNG, JPEG, GIF or WebP image up to ' + (limit >> 20) + ' MiB');
  if (typeof raw !== 'string' || raw.length > 4 * Math.ceil(limit / 3) + 128) throw invalid();
  const comma = raw.indexOf(',');
  const encoded = raw.slice(comma + 1).replace(/[\r\n]/g, '');
  if (!encoded.length || encoded.length % 4 || /[^a-z0-9+/=]/i.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, 'base64');
  const kind = imageExtension(bytes);
  if (
    !kind ||
    bytes.length > limit ||
    raw.slice(0, comma) !== 'data:image/' + kind[0] + ';base64' ||
    bytes.toString('base64') !== encoded
  )
    throw invalid();
  return { bytes, extension: kind[1] };
}

export async function storeWorkspaceImage(
  db: Pick<PoolClient, 'query'>,
  workspaceId: string,
  dataURL: string,
  limit = imageLimit,
  host = mediaOrigin,
) {
  const { bytes, extension } = decodeWorkspaceImage(dataURL, limit);
  const name = await writeImage(bytes, extension, host);
  try {
    await db.query('INSERT INTO assets(name,workspace_id) VALUES($1,$2)', [name, workspaceId]);
  } catch (error) {
    await removeAssetFile(name, host);
    throw error;
  }
  return '/files/' + name;
}

function isRemoteImage(value: string) {
  try {
    const url = new URL(value);
    return (
      value.length <= 4096 && url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export function createWorkspaceMedia(pool: PgPool, host = mediaOrigin) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof WorkspaceError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  app.all(
    '/api/workspaces/:slug/:media{images|emojis}/:id?',
    bodyLimit({ maxSize: 8 << 20, onError: (c) => c.json({ error: 'Invalid JSON' }, 400) }),
    async (c) => {
      const digest = sessionDigest(c);
      if (!digest) throw new WorkspaceError(401, 'Sign in required');
      const write = !['GET', 'HEAD'].includes(c.req.method);
      const emoji = c.req.param('media') === 'emojis';
      const id = c.req.param('id');
      const body = c.req.method === 'POST' ? await c.req.json().catch(() => null) : undefined;
      const client = await pool.connect();
      let ownedFile: string | undefined;
      try {
        await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const scope = await readWorkspaceScope(client, digest, c.req.param('slug'), write);
        const ws = scope.workspace_id;
        if (write && scope.role === 'viewer')
          throw new WorkspaceError(403, 'Workspace editing permission required');
        if (emoji && !write && !id) {
          const list = await client.query(
            'SELECT id,name,url,created_by AS "createdBy",created_at AS "createdAt" FROM workspace_emojis WHERE workspace_id=$1 ORDER BY name',
            [ws],
          );
          await client.query('COMMIT');
          return c.json({ emojis: list.rows });
        }
        if (emoji && c.req.method === 'DELETE' && id) {
          const result = await client.query(
            "DELETE FROM workspace_emojis WHERE workspace_id=$1 AND id=$2 AND (created_by=$3 OR $4='admin')",
            [ws, id, scope.user_id, scope.role],
          );
          if (!result.rowCount) throw new WorkspaceError(404, 'Emoji not found or deletion refused');
          await client.query('COMMIT');
          return c.json({ ok: true });
        }
        if (c.req.method !== 'POST' || id) {
          await client.query('ROLLBACK');
          return c.json({ error: 'Method not allowed' }, 405);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new WorkspaceError(400, 'Invalid JSON');
        if (!emoji) {
          ownedFile = await storeWorkspaceImage(client, ws, body.dataUrl, imageLimit, host);
          await client.query('COMMIT');
          return c.json({ url: ownedFile }, 201);
        }
        const name =
          typeof body.name === 'string'
            ? body.name
                .replace(/^:+|:+$/g, '')
                .trim()
                .toLowerCase()
            : '';
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new WorkspaceError(400, 'Invalid emoji name');
        const { dataUrl = '', url = '' } = body;
        if (typeof url !== 'string' || typeof dataUrl !== 'string' || !!url === !!dataUrl)
          throw new WorkspaceError(400, 'Provide one image upload or HTTPS URL');
        if (url && !isRemoteImage(url)) throw new WorkspaceError(400, 'Image URL must use HTTPS');
        if (dataUrl) ownedFile = await storeWorkspaceImage(client, ws, dataUrl, emojiLimit, host);
        const result = await client.query(
          `INSERT INTO workspace_emojis(id,workspace_id,name,url,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING id,name,url,created_by AS "createdBy",created_at AS "createdAt"`,
          [randomBytes(32).toString('base64url'), ws, name, ownedFile ?? url, scope.user_id],
        );
        await client.query('COMMIT');
        return c.json(result.rows[0], 201);
      } catch (error) {
        await client.query('ROLLBACK');
        if (ownedFile) {
          // COMMIT may have reached PostgreSQL even if its acknowledgement was lost.
          const name = ownedFile.slice('/files/'.length);
          if (!(await client.query('SELECT 1 FROM assets WHERE name=$1', [name])).rowCount)
            await removeAssetFile(name, host);
        }
        if ((error as { code?: string }).code === '23505')
          throw new WorkspaceError(409, 'An emoji with this name already exists');
        throw error;
      } finally {
        client.release();
      }
    },
  );
  return app;
}
