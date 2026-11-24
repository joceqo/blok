// Invoked through stdin and the private Docker network by the opt-in browser smoke.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks));
const access = async (documentId,ticket) => {
  const response = await fetch('http://127.0.0.1:8081/internal/room-access',{
    method:'POST',headers:{authorization:'Bearer '+process.env.INTERNAL_SECRET,'content-type':'application/json'},
    body:JSON.stringify({documentId,ticket}),signal:AbortSignal.timeout(5000),
  });
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-blok-access-backend'),'node');
  return response.json();
};

if (input.revokedTicket) {
  const denied = await access(input.documentId,input.revokedTicket);
  console.log(JSON.stringify({read:denied.read,write:denied.write}));
} else {
  const health = await (await fetch('http://127.0.0.1:18102/healthz')).json();
  assert.equal(health.backend,'node');
  assert.equal(health.workspaceId,input.selected);
  const allowed = await access(input.newPage,input.selectedTicket);
  assert.equal(allowed.workspaceId,input.selected);
  const foreign = await access(input.outsidePage,input.foreignTicket);
  assert.equal(foreign.read,true);
  assert.equal(foreign.workspaceId,input.other);
  // A valid ticket for its own document must still respect the host's workspace selection.
  const status = await new Promise((resolve,reject) => {
    const req = request({
      hostname:'127.0.0.1',port:18102,path:'/api/blok/sync/'+input.outsidePage,
      headers:{ origin:input.origin,upgrade:'websocket',connection:'Upgrade',
        'sec-websocket-key':randomBytes(16).toString('base64'),'sec-websocket-version':'13',
        'sec-websocket-protocol':['blok-sync.v2','blok-sync.v1',input.foreignTicket].join(', ') },
    });
    req.setTimeout(5000,() => req.destroy(new Error('No response from the workspace room')));
    req.once('response',res => { res.resume(); resolve(res.statusCode); });
    req.once('upgrade',(res,socket) => { socket.destroy(); resolve(res.statusCode); });
    req.once('error',reject);
    req.end();
  });
  assert.ok([403,404].includes(status),'Expected the room to refuse this other workspace, got '+status);
  console.log(JSON.stringify({workspaceId:health.workspaceId,foreignId:foreign.workspaceId,
    allowed:{read:allowed.read,write:allowed.write},foreignRoomAllowed:false}));
}
