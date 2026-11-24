// Called by the Go working-set migration test with a private root and DB schema.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Doc } from 'yjs';
import { startJournalRoom } from '../dist/journal-room.mjs';
import { appendJournal } from '../dist/journal-append.mjs';
import { createHash } from 'node:crypto';

const [mode, directory, documentId, lineage] = process.argv.slice(2);
if (mode === '--frames') {
  const doc = new Doc();
  const frames = [];
  doc.on('update', (update) => frames.push(Buffer.from(update).toString('base64')));
  for (const title of ['First', 'Legacy', 'Continued']) doc.getMap('page').set('title', title);
  doc.destroy();
  console.log(JSON.stringify(frames));
} else {
  assert.ok(['fresh', 'known'].includes(mode));
  assert.ok(process.env.SHELL_TEST_DATABASE_URL);
  const root = process.env.BLOK_SHELL_TEST_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url));
  const require = createRequire(resolve(root, 'apps/service-node/package.json'));
  const { Pool } = require('pg');
  const { serve } = require('@hono/node-server');
  const { createShellApp } = await import(
    pathToFileURL(resolve(root, 'apps/service-node/dist/shell/app.js'))
  );
  const schema = 'legacy_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.SHELL_TEST_DATABASE_URL });
  const db = new Pool({
    connectionString: process.env.SHELL_TEST_DATABASE_URL,
    options: '-csearch_path=' + schema,
  });
  const secret = 'i'.repeat(40),
    data = { time: 123, blocks: [], title: 'Legacy' };
  const update = await buffer(process.stdin);
  let service, room;
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(resolve(root, 'apps/service/schema.sql'), 'utf8'));
    await db.query("INSERT INTO workspaces(id,slug,name) VALUES('w','w','W')");
    await db.query(
      `INSERT INTO pages(id,workspace_id,metadata,content,version,lineage,sequence)
      VALUES($1,'w','{}',$2,8,$3,$4)`,
      [documentId, data, mode === 'known' ? lineage : null, mode === 'known' ? '0' : null],
    );
    service = serve({ fetch: createShellApp(db, secret, new Set()).fetch, port: 0, hostname: '127.0.0.1' });
    if (!service.listening) await once(service, 'listening');
    const options = {
      directory,
      documentId,
      allowedOrigins: new Set(['http://localhost']),
      authorize: async () => null,
      projection: { origin: 'http://127.0.0.1:' + service.address().port, secret },
    };
    const head = async () =>
      (
        await db.query('SELECT content,version::text,lineage,sequence::text FROM pages WHERE id=$1', [
          documentId,
        ])
      ).rows[0];
    room = await startJournalRoom(options);
    const expectedVersion = mode === 'known' ? 8 : 9;
    assert.deepEqual(await head(), {
      content: data,
      version: String(expectedVersion),
      lineage,
      sequence: '0',
    });
    await room.close();
    room = undefined;
    const key = createHash('sha256').update(documentId).digest('hex');
    const appended = await appendJournal(resolve(directory, key + '.journal'), {
      expectedLineage: lineage,
      expectedThrough: 0n,
      operationId: 'a'.repeat(32),
      actorId: null,
      source: 0,
      update,
    });
    assert.deepEqual(appended, { outcome: 'committed', sequence: 1n });
    for (let i = 0; i < 2; i++) {
      room = await startJournalRoom(options);
      assert.deepEqual(await head(), {
        content: { ...data, title: 'Continued' },
        version: String(expectedVersion + 1),
        lineage,
        sequence: '1',
      });
      await room.close();
      room = undefined;
    }
  } finally {
    await room?.close();
    if (service) await new Promise((ok) => service.close(ok));
    await db.end();
    try {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.end();
    }
  }
}
