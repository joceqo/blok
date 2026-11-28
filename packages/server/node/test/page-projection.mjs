// Build the room and apps/service-node first. This opt-in suite owns one temporary schema.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { WebSocket } from 'ws';
import { Doc, applyUpdate, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import * as w from 'lib0/encoding';
import * as r from 'lib0/decoding';
import { startJournalRoom } from '../dist/journal-room.mjs';

const url = process.env.SHELL_TEST_DATABASE_URL;
test(
  'durable edits persist to the canonical Node service/PostgreSQL with exact CAS',
  { skip: !url, timeout: 30000 },
  async () => {
    const root = process.env.BLOK_SHELL_TEST_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url));
    const require = createRequire(resolve(root, 'apps/service-node/package.json'));
    const { Pool } = require('pg');
    const { serve } = require('@hono/node-server');
    const { createShellApp } = await import(
      pathToFileURL(resolve(root, 'apps/service-node/dist/shell/app.js')).href
    );
    const schema = 'test_project_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: url });
    const db = new Pool({ connectionString: url, options: '-csearch_path=' + schema });
    const directory = await mkdtemp(join(tmpdir(), 'blok-page-'));
    const secret = 'z'.repeat(40),
      origin = 'http://localhost:18098',
      documentId = 'inspect-example';
    const load = async () =>
      (
        await db.query(
          "SELECT content,version::text,lineage,sequence::text FROM pages WHERE id='inspect-example'",
        )
      ).rows[0];
    let service,
      room,
      loseReceipt = false,
      loseBeforeCommit = false;
    try {
      await admin.query('CREATE SCHEMA ' + schema);
      await db.query(await readFile(resolve(root, 'apps/service/schema.sql'), 'utf8'));
      const data = {
        title: 'Seed',
        time: 19,
        blocks: [{ id: 'a', type: 'paragraph', data: { text: 'Hello' } }],
      };
      await db.query("INSERT INTO workspaces(id,slug,name) VALUES('w','demo','Demo')");
      await db.query(
        "INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES('inspect-example','w','{}',$1,'workspace')",
        [data],
      );
      const app = createShellApp(db, secret, new Set());
      service = serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: async (req) => {
          if (req.method === 'PUT' && loseBeforeCommit) {
            loseBeforeCommit = false;
            return new Response(null, { status: 503 });
          }
          const reply = await app.fetch(req);
          if (req.method === 'PUT' && loseReceipt) {
            loseReceipt = false;
            return new Response(null, { status: 503 });
          }
          return reply;
        },
      });
      if (!service.listening) await new Promise((ok) => service.once('listening', ok));
      const options = {
        directory,
        documentId,
        allowedOrigins: new Set([origin]),
        authorize: async () => ({ id: 'test', write: true }),
        projection: { origin: 'http://127.0.0.1:' + service.address().port, secret },
      };
      room = await startJournalRoom(options);
      const seeded = await load();
      assert.equal(seeded.sequence, '0');
      assert.equal(seeded.version, '1');
      assert.deepEqual(seeded.content, data);
      const lineage = seeded.lineage;
      assert.match(lineage, /^[a-f0-9]{32}$/);

      async function connect() {
        const ws = new WebSocket(room.url, ['blok-sync.v2', 't'], { origin });
        const inbox = [];
        let wake;
        const closed = new Promise((ok) =>
          ws.once('close', (code) => {
            ok(code);
            doc.destroy();
          }),
        );
        ws.on('message', (bytes) => {
          inbox.push(r.createDecoder(bytes));
          wake?.();
        });
        const doc = new Doc();
        async function next(type) {
          if (!inbox.length)
            await new Promise((ok, fail) => {
              const timer = setTimeout(() => fail(new Error('Missing frame ' + type)), 3500);
              wake = () => {
                clearTimeout(timer);
                wake = undefined;
                ok();
              };
            });
          const input = inbox.shift();
          assert.equal(r.readVarUint(input), type);
          return input;
        }
        await next(100);
        await next(101);
        const send = (type, encode) => {
          const out = w.createEncoder();
          w.writeVarUint(out, type);
          encode(out);
          ws.send(w.toUint8Array(out));
        };
        send(0, (out) => {
          w.writeVarUint(out, 0);
          w.writeVarUint8Array(out, encodeStateVector(doc));
        });
        const sync = await next(0);
        assert.equal(r.readVarUint(sync), 1);
        applyUpdate(doc, r.readVarUint8Array(sync));
        await next(0);
        return {
          doc,
          closed,
          sendOp(id, update) {
            send(102, (out) => {
              w.writeVarString(out, JSON.stringify({ lineage, operationId: id }));
              w.writeVarUint8Array(out, update);
            });
          },
          next,
        };
      }
      let editor = await connect();
      const edit = (suffix) => {
        const before = encodeStateVector(editor.doc);
        const text = editor.doc.getMap('blocks').get('a').get('data').get('text');
        text.insert(text.length, suffix);
        return encodeStateAsUpdate(editor.doc, before);
      };
      const op = () => randomBytes(16).toString('hex');
      editor.sendOp(op(), edit('!'));
      await editor.next(0);
      assert.equal(JSON.parse(r.readVarString(await editor.next(103))).serverSequence, '1');
      assert.deepEqual((await load()).content, {
        ...data,
        blocks: [{ id: 'a', type: 'paragraph', data: { text: 'Hello!' } }],
      });

      for (const failure of ['before', 'after']) {
        const id = op(),
          bytes = edit(failure);
        if (failure === 'before') loseBeforeCommit = true;
        else loseReceipt = true;
        editor.sendOp(id, bytes);
        assert.equal(await editor.closed, 4503);
        await room.close();
        room = await startJournalRoom(options);
        editor = await connect();
        editor.sendOp(id, bytes);
        assert.equal(
          JSON.parse(r.readVarString(await editor.next(103))).serverSequence,
          failure === 'before' ? '2' : '3',
        );
      }
      // Optional genuine Go Store.Open, using its conformance fixture for inspect-example.
      if (process.env.BLOK_GO_JOURNAL_HOLDER) {
        await room.close();
        const go = spawnSync(process.env.BLOK_GO_JOURNAL_HOLDER, [directory], {
          input: '',
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(go.status, 0, go.stderr);
        assert.equal(go.stdout.trim(), '3');
        room = await startJournalRoom(options);
        editor = await connect();
      }
      const stable = await load();
      assert.deepEqual([stable.version, stable.lineage, stable.sequence], ['4', lineage, '3']);
      assert.equal(stable.content.blocks[0].data.text, 'Hello!beforeafter');

      await db.query(
        "UPDATE pages SET version=version+1,content=jsonb_set(content,'{title}','\"External\"') WHERE id='inspect-example'",
      );
      editor.sendOp(op(), edit('conflict'));
      assert.equal(await editor.closed, 4503);
      await room.close();
      room = undefined;
      assert.equal((await load()).content.title, 'External');
      await assert.rejects(startJournalRoom(options), /changed since/);
    } finally {
      await room?.close();
      if (service) await new Promise((ok) => service.close(ok));
      await rm(directory, { recursive: true, force: true });
      await db.end();
      try {
        await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      } finally {
        await admin.end();
      }
    }
  },
);
