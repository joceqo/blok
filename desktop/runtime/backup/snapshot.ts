import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PrivateS3Store } from '../../../packages/server/node/src/blob/s3.ts';
import { open, writeFile, mkdir, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PgPool } from '../../../apps/service-node/src/db/pool.ts';
import { inspectJournal } from '../../../packages/server/node/src/collab/journal/inspect.ts';
import { isGenerated } from '../../../packages/server/node/src/blob/key.ts';
import { portableValue, restoredValue } from './references.ts';

export interface AssetStore {
  getObject(key: string): Promise<Buffer | undefined>;
  putObject(key: string, data: Buffer): Promise<void>;
  deleteObject(key: string): Promise<void>;
}
interface Page {
  id: string;
  metadata: Record<string, unknown>;
  content: unknown;
  visibility: string;
  trashed: boolean;
  sequence: string | null;
  lineage: string | null;
}
interface Asset {
  name: string;
  document_id: string | null;
  digest: string;
  size: number;
}
interface Team {
  id: string;
  name: string;
  description: string;
  icon: string;
  is_default: boolean;
  owner_managed: boolean;
  role: string | null;
}
interface Event {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  page_id: string | null;
  revision: number;
  detached_private: boolean;
}
interface Snapshot {
  format: 'blok-workspace';
  version: 1;
  workspace: { id: string; name: string; restrict_teamspace_creation: boolean };
  capturedAt: string;
  pages: Page[];
  assets: Asset[];
  teams: Team[];
  teamPages: { teamspace_id: string; page_id: string }[];
  emojis: { id: string; name: string; url: string }[];
  events: Event[];
}
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export async function safeRead(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Fichier de sauvegarde invalide ou trop grand.');
    return await file.readFile();
  } finally {
    await file.close();
  }
}
const maxMetadata = 128 * 1024 * 1024;
export async function capture(
  pool: PgPool,
  store: PrivateS3Store,
  origin: string,
  data: string,
  workspace: string,
  folder: string,
) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {
      rows: [ws],
    } = await db.query(
      `SELECT w.id,w.name,w.restrict_teamspace_creation FROM workspaces w
      JOIN memberships m ON m.workspace_id=w.id AND m.role='admin' JOIN desktop_device_account d ON d.user_id=m.user_id
      WHERE w.id=$1 AND NOT EXISTS (SELECT FROM memberships other WHERE other.workspace_id=w.id AND other.user_id<>d.user_id)`,
      [workspace],
    );
    if (!ws) throw new Error('Sélectionnez un espace personnel de cet appareil.');
    const rows = async (sql: string) => (await db.query(sql, [workspace])).rows;
    const pages = (await rows(
      'SELECT id,metadata,content,visibility,trashed,lineage,sequence FROM pages WHERE workspace_id=$1 AND NOT deleted ORDER BY id',
    )) as Page[];
    const entries = await rows(
      'SELECT name,document_id FROM assets WHERE workspace_id=$1 AND (document_id IS NULL OR document_id IN (SELECT id FROM pages WHERE workspace_id=$1 AND NOT deleted)) ORDER BY name',
    );
    const names = new Set(entries.map((a) => a.name as string));
    const teams =
      await rows(`SELECT t.id,t.name,t.description,t.icon,t.is_default,t.owner_managed,m.role FROM teamspaces t LEFT JOIN teamspace_members m
      ON m.teamspace_id=t.id AND m.user_id=(SELECT user_id FROM desktop_device_account WHERE singleton) WHERE t.workspace_id=$1 ORDER BY t.id`);
    const teamPages = await rows(
      'SELECT teamspace_id,page_id FROM teamspace_pages JOIN pages ON id=page_id WHERE teamspace_pages.workspace_id=$1 AND NOT deleted',
    );
    const emojis = await rows('SELECT id,name,url FROM workspace_emojis WHERE workspace_id=$1');
    const events = await rows(
      'SELECT id,title,starts_at,ends_at,all_day,page_id,revision,detached_private FROM workspace_calendar_events WHERE workspace_id=$1',
    );
    for (const page of pages) {
      const journal = join(data, 'collab', sha(page.id) + '.journal');
      if (
        await stat(journal).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
          return null;
        })
      ) {
        const head = await inspectJournal(journal);
        const seq = head.journal?.durableThrough ?? 0n;
        if (
          head.integrity !== 'ok' ||
          head.state === 'purged' ||
          (seq > 0n && (head.manifest?.lineage !== page.lineage || seq !== BigInt(page.sequence ?? -1)))
        )
          throw new Error('Une page se synchronise encore. Réessayez dans un instant : ' + page.id);
      }
      page.metadata = portableValue(page.metadata, origin, names) as Page['metadata'];
      page.content = portableValue(page.content, origin, names);
    }
    await db.query('COMMIT');
    await mkdir(join(folder, 'attachments'), { mode: 0o700 });
    const assets: Asset[] = [];
    for (const row of entries) {
      if (!isGenerated(row.name)) throw new Error('Clé média invalide.');
      const hash = createHash('sha256');
      let size = 0;
      const expected = await store.fileStat(row.name);
      const count = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(
        store.openReadStream(row.name),
        count,
        createWriteStream(join(folder, 'attachments', row.name), { flags: 'wx', mode: 0o600 }),
      );
      if (size !== expected.size) throw new Error('Pièce jointe incomplète : ' + row.name);
      assets.push({ name: row.name, document_id: row.document_id, size, digest: hash.digest('hex') });
    }
    const manifest = JSON.stringify(
      {
        format: 'blok-workspace',
        version: 1,
        capturedAt: new Date().toISOString(),
        workspace: ws,
        pages,
        teams: portableValue(teams, origin, names),
        teamPages,
        emojis: portableValue(emojis, origin, names),
        events,
        assets,
      },
      null,
      2,
    );
    if (Buffer.byteLength(manifest) > maxMetadata) throw new Error('Le manifeste dépasse 128 Mio.');
    await writeFile(join(folder, 'workspace.json'), manifest, { flag: 'wx', mode: 0o600 });
    await writeFile(join(folder, 'complete.sha256'), sha(manifest) + '\n', { flag: 'wx', mode: 0o600 });
  } finally {
    try {
      await db.query('ROLLBACK');
    } finally {
      db.release();
    }
  }
}

export async function readSnapshot(folder: string): Promise<Snapshot> {
  const bytes = await safeRead(join(folder, 'workspace.json'), maxMetadata);
  if (sha(bytes) !== (await safeRead(join(folder, 'complete.sha256'), 65)).toString().trim())
    throw new Error('Sauvegarde incomplète ou modifiée.');
  const s = JSON.parse(bytes.toString()) as Snapshot;
  if (
    s.format !== 'blok-workspace' ||
    s.version !== 1 ||
    !s.workspace?.id ||
    !s.workspace.name ||
    ![s.pages, s.teams, s.assets, s.emojis, s.events, s.teamPages].every(Array.isArray)
  )
    throw new Error('Format de sauvegarde inconnu.');
  if (
    new Set(s.pages.map((p) => p.id)).size !== s.pages.length ||
    new Set(s.assets.map((a) => a.name)).size !== s.assets.length ||
    !s.assets.every(
      (a) =>
        isGenerated(a.name) && /^[a-f0-9]{64}$/.test(a.digest) && Number.isSafeInteger(a.size) && a.size >= 0,
    )
  )
    throw new Error('Inventaire de sauvegarde invalide.');
  return s;
}

export async function restore(pool: PgPool, store: PrivateS3Store, origin: string, folder: string) {
  const s = await readSnapshot(folder);
  const db = await pool.connect();
  const target = randomUUID();
  const pages = new Map(s.pages.map((p) => [p.id, randomUUID()]));
  const teams = new Map(s.teams.map((t) => [t.id, randomUUID()]));
  const media = new Map<string, string>();
  const added: string[] = [];
  let committing = false;
  try {
    for (const a of s.assets) {
      // Only generated keys and regular files underneath the selected snapshot may be read.
      const dir = await lstat(join(folder, 'attachments'));
      if (!dir.isDirectory()) throw new Error('Dossier média invalide.');
      const f = await open(
        join(folder, 'attachments', a.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await f.stat();
        const hash = createHash('sha256');
        if (!info.isFile() || info.size !== a.size) throw new Error('Pièce jointe incomplète : ' + a.name);
        for await (const bytes of f.createReadStream({ autoClose: false })) hash.update(bytes);
        if (hash.digest('hex') !== a.digest) throw new Error('Pièce jointe endommagée : ' + a.name);
        const name = randomBytes(16).toString('hex') + a.name.slice(32);
        await store.putStream(name, f.createReadStream({ start: 0, autoClose: false }), a.size, a.digest);
        added.push(name);
        media.set(a.name, name);
      } finally {
        await f.close();
      }
    }
    await db.query('BEGIN');
    const {
      rows: [account],
    } = await db.query('SELECT user_id FROM desktop_device_account WHERE singleton');
    if (!account) throw new Error('Profil local introuvable.');
    const owner = account.user_id;
    await db.query(
      'INSERT INTO workspaces(id,slug,name,revision,restrict_teamspace_creation) VALUES($1,$2,$3,1,$4)',
      [
        target,
        'copie-' + target,
        s.workspace.name.slice(0, 90) + ' (restauré)',
        s.workspace.restrict_teamspace_creation,
      ],
    );
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [
      target,
      owner,
    ]);
    const rewrite = (v: unknown) => restoredValue(v, pages, media, s.workspace.id, target, origin);
    for (const p of s.pages) {
      const id = pages.get(p.id);
      await db.query(
        'INSERT INTO pages(id,workspace_id,metadata,content,visibility,trashed) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)',
        [
          id,
          target,
          JSON.stringify({ ...(rewrite(p.metadata) as object), id }),
          p.content == null ? null : JSON.stringify(rewrite(p.content)),
          p.visibility,
          p.trashed,
        ],
      );
      if (p.visibility === 'private')
        await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,'full',$2)", [
          id,
          owner,
        ]);
    }
    for (const a of s.assets)
      await db.query('INSERT INTO assets(name,workspace_id,document_id) VALUES($1,$2,$3)', [
        media.get(a.name),
        target,
        a.document_id === null ? null : required(pages, a.document_id),
      ]);
    for (const t of s.teams) {
      await db.query(
        'INSERT INTO teamspaces(id,workspace_id,name,description,icon,is_default,owner_managed) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [teams.get(t.id), target, t.name, t.description, rewrite(t.icon), t.is_default, t.owner_managed],
      );
      if (t.role)
        await db.query(
          'INSERT INTO teamspace_members(workspace_id,teamspace_id,user_id,role) VALUES($1,$2,$3,$4)',
          [target, teams.get(t.id), owner, t.role],
        );
    }
    for (const r of s.teamPages)
      await db.query('INSERT INTO teamspace_pages(workspace_id,teamspace_id,page_id) VALUES($1,$2,$3)', [
        target,
        required(teams, r.teamspace_id),
        required(pages, r.page_id),
      ]);
    for (const e of s.emojis)
      await db.query(
        'INSERT INTO workspace_emojis(id,workspace_id,name,url,created_by) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), target, e.name, rewrite(e.url), owner],
      );
    for (const e of s.events)
      await db.query(
        `INSERT INTO workspace_calendar_events(workspace_id,id,title,starts_at,ends_at,all_day,page_id,revision,detached_private,organizer_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          target,
          e.id,
          e.title,
          e.starts_at,
          e.ends_at,
          e.all_day,
          e.page_id ? required(pages, e.page_id) : null,
          e.revision,
          e.detached_private,
          owner,
        ],
      );
    committing = true;
    await db.query('COMMIT');
    return target;
  } catch (error) {
    await db.query('ROLLBACK');
    // A lost COMMIT acknowledgement may already have published the workspace.
    if (!committing) for (const key of added) await store.deleteObject(key).catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}
function required(map: Map<string, string>, id: string) {
  const value = map.get(id);
  if (!value) throw new Error('Référence absente de la sauvegarde : ' + id);
  return value;
}
