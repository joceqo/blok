// Run by TestNodeShellTicketAndAdmissionParity in the Go product service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createShellApp } from '../dist/shell/app.js';

const config = JSON.parse(await text(process.stdin));
process.env.TICKET_SECRET = config.ticket;
const dbUrl = new URL(config.database);
const schema = dbUrl.searchParams.get('search_path');
assert.match(schema, /^reads_test_[0-9]+$/);
dbUrl.searchParams.delete('search_path');
const db = new pg.Pool({ connectionString: dbUrl.href, options: '-csearch_path=' + schema });
const app = createShellApp(db, config.internal, new Set());
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
if (!server.listening) await once(server, 'listening');
const node = 'http://127.0.0.1:' + server.address().port;
const origins = [config.goOrigin, node];
const session = (actor) =>
  createHash('sha256')
    .update('token-' + actor)
    .digest('hex');
let checks = 0;

async function ticket(actor, doc, scoped, expectedStatus, write) {
  const path =
    (scoped ? '/api/workspaces/' + scoped + '/ticket' : '/api/blok-ticket') +
    '?doc=' +
    encodeURIComponent(doc);
  const issued = [];
  for (const origin of origins) {
    const now = Math.floor(Date.now() / 1000);
    const res = await fetch(origin + path, { headers: { Authorization: 'Bearer token-' + actor } });
    const data = await res.json();
    assert.equal(res.status, expectedStatus, actor + ' ' + path + ' ' + JSON.stringify(data.error));
    if (origin === node) assert.equal(res.headers.get('X-Blok-Ticket-Backend'), 'node');
    if (expectedStatus === 200) {
      const claims = JSON.parse(Buffer.from(data.ticket.split('.')[1], 'base64url').toString());
      assert.deepEqual([claims.user, claims.doc, claims.write], [session(actor), doc, write]);
      assert.ok(claims.exp >= now + 60 && claims.exp <= Math.floor(Date.now() / 1000) + 60);
      issued.push(data.ticket);
    }
    checks++;
  }
  return issued;
}

async function decide(input, expected, status = 200) {
  for (const origin of origins) {
    const res = await fetch(origin + '/internal/room-access', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.internal, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    assert.equal(res.status, status, JSON.stringify(data.error));
    if (origin === node) {
      assert.equal(res.headers.get('X-Blok-Access-Backend'), 'node');
      if (expected?.read) assert.equal(data.workspaceId, 'w');
      else assert.equal(data.workspaceId, undefined);
      delete data.workspaceId;
    }
    if (status === 200) assert.deepEqual(data, expected);
    checks++;
  }
}

try {
  const flags = async (doc) =>
    (await db.query('SELECT admission_started AS flag FROM pages WHERE id=$1', [doc])).rows[0].flag;
  assert.equal(await flags('prive'), false);
  await ticket('zoe', 'prive', null, 403);
  await ticket('alice', 'prive', 'equipe', 404);
  await ticket('missing', 'public', null, 401);
  await ticket('alice', 'missing', 'equipe', 404);
  assert.equal(await flags('prive'), false);
  const owners = await ticket('bob', 'prive', 'equipe', 200, true);
  for (const pass of owners) {
    await decide(
      { ticket: pass, documentId: 'prive' },
      { read: true, write: true, ticketWrite: true, session: session('bob') },
    );
    await decide({ ticket: pass, documentId: 'public' }, null, 401);
  }
  // Exercise Node's own first-admission write independently of Go's.
  await db.query("UPDATE pages SET admission_started=false WHERE id='prive'");
  const cookie = await fetch(node + '/api/blok-ticket?doc=prive', {
    headers: { Cookie: 'blok_session=token-bob' },
  });
  assert.equal(cookie.status, 200);
  assert.equal(await flags('prive'), true);
  await ticket('alice', 'public', 'w', 200, true);
  await db.query(
    "INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('prive','alice','view','bob')",
  );
  const readers = await ticket('alice', 'enfant', null, 200, false);
  await db.query("UPDATE page_shares SET level='edit' WHERE user_id='alice'");
  for (const pass of readers)
    await decide(
      { ticket: pass, documentId: 'enfant' },
      { read: true, write: false, ticketWrite: false, session: session('alice') },
    );
  await decide({ session: session('alice'), documentId: 'enfant' }, { read: true, write: true });
  await db.query("UPDATE memberships SET role='viewer' WHERE user_id='alice'");
  await db.query("UPDATE page_shares SET level='full' WHERE user_id='alice'");
  await ticket('alice', 'enfant', 'w', 200, false);
  await decide({ session: session('alice'), documentId: 'enfant' }, { read: true, write: false });
  await db.query("DELETE FROM page_shares WHERE user_id='alice'");
  for (const pass of readers)
    await decide({ ticket: pass, documentId: 'enfant' }, { read: false, write: false });
  await db.query("DELETE FROM memberships WHERE user_id='bob'");
  await decide({ ticket: owners[1], documentId: 'prive' }, { read: false, write: false });
  await db.query("INSERT INTO workspaces(id,slug,name) VALUES('other','w','Other')");
  await ticket('alice', 'public', 'w', 403);
  await db.query("UPDATE pages SET trashed=true WHERE id='public'");
  await ticket('alice', 'public', null, 403);
  await decide({ session: session('alice'), documentId: 'public' }, { read: false, write: false });
  await db.query("UPDATE sessions SET expires_at=now() WHERE user_id='zoe'");
  await ticket('zoe', 'public', null, 401);
  await decide({ session: session('zoe'), documentId: 'public' }, { read: false, write: false });
  await decide({ session: 'malformed', documentId: 'public' }, null, 400);
  await decide({ ticket: owners[0], session: session('bob'), documentId: 'prive' }, null, 400);
  console.log(checks + ' concordant HTTP decisions across Go and Node');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await db.end();
}
