// The Go integration fixture passes its ephemeral local service and accounts on stdin.
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Doc, applyUpdate, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { startJournalRoom, shellRoomTickets } from '../dist/journal-room.mjs';
import { randomBytes } from 'node:crypto';

let config = '';
for await (const text of process.stdin) config += text;
const {origin, secret, owner, member} = JSON.parse(config);
assert.equal(new URL(origin).hostname,'127.0.0.1');
const dir = await mkdtemp(join(tmpdir(),'blok-shell-room-'));
const lineage = '00112233445566778899aabbccddeeff';
const timeout = (name) => new Error('Timed out waiting for ' + name);
const api = '/api/workspaces/equipe';
async function cloud(path, token, method = 'GET', body) {
  const response = await fetch(origin+api+path, { method, headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:body && JSON.stringify(body), signal:AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, method + ' ' + path);
  return response.json();
}
async function share(level) {
  await cloud('/pages/prive/shares/alice',owner,level ? 'PUT':'DELETE',level && {level});
}
async function pass(token) { return (await cloud('/ticket?doc=prive',token)).ticket; }
function frame(type, build) {
  const out = encoding.createEncoder();
  encoding.writeVarUint(out,type); build(out);
  return encoding.toUint8Array(out);
}
let room;
async function client(ticket) {
  const doc = new Doc();
  const socket = new WebSocket(room.url,['blok-sync.v2','blok-sync.v1',ticket],{origin});
  const messages = [];
  let wake;
  socket.on('message', bytes => { messages.push(new Uint8Array(bytes)); wake?.(); });
  const closed = new Promise(ok => socket.once('close',code=>{doc.destroy();ok(code);}));
  await new Promise((ok,fail) => {socket.once('open',ok);socket.once('error',fail);});
  async function next(type) {
    if (!messages.length) await new Promise((ok,fail) => {
      const timer = setTimeout(() => fail(timeout('frame ' + type)),3500);
      wake = () => {clearTimeout(timer);wake=undefined;ok();};
    });
    const message = decoding.createDecoder(messages.shift());
    assert.equal(decoding.readVarUint(message),type);
    return message;
  }
  await next(100); await next(101);
  socket.send(frame(0,out=>{encoding.writeVarUint(out,0);encoding.writeVarUint8Array(out,encodeStateVector(doc));}));
  const sync = await next(0);
  assert.equal(decoding.readVarUint(sync),1);
  applyUpdate(doc,decoding.readVarUint8Array(sync));
  assert.equal(decoding.readVarUint(await next(0)),0);
  return {
    doc, closed,
    write(text) {
      const before = encodeStateVector(doc);
      doc.getText('canonical-room').insert(0,text);
      socket.send(frame(102,out=>{
        encoding.writeVarString(out,JSON.stringify({lineage,operationId:randomBytes(16).toString('hex')}));
        encoding.writeVarUint8Array(out,encodeStateAsUpdate(doc,before));
      }));
    },
    async relay() {
      const message = await next(0);
      assert.equal(decoding.readVarUint(message),2);
      applyUpdate(doc,decoding.readVarUint8Array(message));
    },
    async receipt(type) {return JSON.parse(decoding.readVarString(await next(type)));},
  };
}
try {
  await cp(fileURLToPath(new URL('./fixtures/go-journal-rich',import.meta.url)),dir,{recursive:true});
  room = await startJournalRoom({directory:dir, documentId:'prive', allowedOrigins:new Set([origin]),authorize:shellRoomTickets(origin,secret)});
  await share('edit');
  const bob = await client(await pass(owner));
  const aliceTicket = await pass(member);
  const alice = await client(aliceTicket);
  alice.write('accepted');
  await alice.relay(); await bob.relay();
  assert.equal((await alice.receipt(103)).serverSequence,'4');
  assert.equal(bob.doc.getText('canonical-room').toString(),'accepted');

  await share('view');
  alice.write('denied');
  assert.equal((await alice.receipt(104)).code,'read-only');
  const reader = await client(await pass(member));
  await share('edit');
  reader.write('ticket ceiling');
  assert.equal((await reader.receipt(104)).code,'read-only');

  await share(null);
  // An idle peer also loses its socket, independent of sending its own next operation.
  alice.write('revoked');
  assert.equal(await alice.closed,4403);
  assert.equal(await reader.closed,4403);
  await assert.rejects(client(aliceTicket), /403/);
  bob.write('owner');
  await bob.relay();
  assert.equal((await bob.receipt(103)).serverSequence,'5');
  console.log('Go-minted tickets, two Yjs clients, edit → view → revoked, idle 4403, ticket ceiling, owner committed sequence 5');
} finally {
  await room?.close();
  await rm(dir,{recursive:true,force:true});
}
