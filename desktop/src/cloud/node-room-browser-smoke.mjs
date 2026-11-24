// The launcher creates an isolated Compose project with loopback ports and the local mailbox.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';

const run = promisify(execFile);
const timeout = 35_000;
const origin = port => {
  assert(/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535);
  return 'http://localhost:' + port;
};
const baseURL = origin(process.env.DEMO_WEB_PORT);
const mailbox = origin(process.env.DEMO_MAIL_PORT);
assert(process.env.COMPOSE_PROJECT_NAME?.startsWith('blok-room-browser-') && process.env.DEMO_ENV_FILE,
  'Run deploy/test-node-room-browser.sh so the restart uses this test’s Docker project.');
const id = randomUUID();
const slug = 'browser-' + id.slice(0, 8);
const ownerEmail = 'admin@example.test', editorEmail = 'editor@example.test';
const workspace = '/api/workspaces/' + slug;
const workspaceName = 'Collaboration Node ' + slug;
const path = '/?page=' + id;
const pageAPI = workspace + '/pages/' + id;
const editorSelector = '[data-blok-redactor] [contenteditable="true"]';
const block = (page, text) => page.locator(editorSelector).filter({ hasText: text }).first();

async function demo(...args) {
  try {
    return await run('./deploy/demo.sh', args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error('demo.sh ' + args.join(' ') + ' failed: ' + String(error.stderr ?? '').slice(-1200));
  }
}
async function api(context, method, url, expected, data) {
  const res = await context.request.fetch(url, { method, data, maxRedirects: 0 });
  assert.equal(res.status(), expected, method + ' ' + url);
  return res;
}
async function login(context, email) {
  await api(context, 'POST', '/api/auth/request-code', 200, { email });
  const inbox = await context.newPage();
  try {
    await inbox.goto(mailbox);
    const letter = inbox.locator('article').filter({ has: inbox.getByRole('heading', {name:email,exact:true}) });
    await expect.poll(async () => {
      await inbox.reload();
      return await letter.locator('.code').count();
    }, { timeout, message: 'Expected a login code in the local demo mailbox' }).toBe(1);
    const code = await letter.locator('.code').textContent();
    assert.match(code, /^\d{6}$/);
    return await (await api(context, 'POST', '/api/auth/verify-code', 200, { email, code })).json();
  } finally {
    await inbox.close();
  }
}
async function launch() {
  try { return await chromium.launch({ headless:true }); }
  catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error;
    return chromium.launch({ headless:true, channel:'chrome' });
  }
}
async function roomTab(context) {
  // Network emulation can leave an established WebSocket open. Close that socket too at the offline boundary.
  await context.addInitScript(() => {
    const sockets = new Set();
    const WebSocketBase = window.WebSocket;
    window.WebSocket = class extends WebSocketBase {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname.startsWith('/api/blok/sync/')) {
          sockets.add(this);
          this.addEventListener('close', () => sockets.delete(this), {once:true});
        }
      }
    };
    window.closeBrowserSmokeSockets = () => { for (const socket of sockets) socket.close(4000, 'Test offline'); };
  });
  const tab = await context.newPage();
  const cdp = await context.newCDPSession(tab);
  const targets = new Set(), connected = new Set(), closed = new Set();
  cdp.on('Network.webSocketCreated', event => {
    if (new URL(event.url).pathname === '/api/blok/sync/' + id) targets.add(event.requestId);
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', ({requestId,response}) => {
    if (!targets.has(requestId) || response.status !== 101) return;
    const marker = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'x-blok-collaboration');
    if (String(marker?.[1]).toLowerCase() === 'node') connected.add(requestId);
  });
  cdp.on('Network.webSocketClosed', ({requestId}) => { if (connected.has(requestId)) closed.add(requestId); });
  await cdp.send('Network.enable');
  const session = await (await api(context,'GET','/api/session',200)).json();
  await tab.goto('/?cloud=1');
  if (session.workspaces.length > 1) {
    const row = tab.locator('[data-cloud-row]').filter({hasText:workspaceName});
    await row.getByRole('button',{name:'Ouvrir l’espace'}).click({timeout});
  }
  await expect(tab.locator('[data-blok-sidebar]')).toBeVisible({timeout});
  if (new URL(tab.url()).searchParams.get('page') !== id) await tab.goto(path);
  return { tab, connected, closed };
}
const saved = page => expect(page.locator('[data-desktop-status]')).toHaveAttribute('data-sync-state','connected',{timeout});
const waitNode = (trace, previous = 0) => expect.poll(() => trace.connected.size,
  {timeout,message:'Expected a new 101 from the Node room on the selected document'}).toBeGreaterThan(previous);
async function append(page, needle, suffix) {
  const field = block(page, needle);
  await expect(field).toBeEditable({timeout});
  await field.press('End');
  await page.keyboard.insertText(suffix);
  await expect(field).toContainText(suffix,{timeout});
}

const browsers = [];
try {
  browsers.push(await launch());
  browsers.push(await launch());
  const owner = await browsers[0].newContext({baseURL}), editor = await browsers[1].newContext({baseURL});
  await login(owner, ownerEmail);
  await api(owner, 'POST', '/api/workspaces', 201, {slug,name:workspaceName});
  await api(owner, 'POST', workspace+'/invites', 201, {email:editorEmail,role:'member'});
  const member = await login(editor, editorEmail);
  assert.ok(member.workspaces.some(w => w.slug===slug && w.role==='member'));
  const index = await (await api(owner,'GET',workspace+'/index',200)).json();
  await api(owner,'PUT',workspace+'/index',200,{revision:index.revision,pages:[
    ...index.pages, {id,title:'Collaboration Node',parentId:null,initialVisibility:'private'},
  ],trash:index.trash});
  const paragraphs = ['Ligne propriétaire','Ligne éditeur'];
  const blocks = paragraphs.map((text, i) => ({ id: 'line-'+(i+1), type:'paragraph', data:{text} }));
  await api(owner,'POST',pageAPI+'/seed',200,{document:{blocks}});
  await api(editor,'GET',pageAPI,404);
  const grant = pageAPI + '/shares/' + encodeURIComponent(member.user.id);
  await api(owner,'PUT',grant,200,{level:'edit'});
  await demo('room-enable',id);
  console.log('Created a private document, granted its editor and selected its Node room.');
  const [first,second] = await Promise.all([roomTab(owner),roomTab(editor)]);
  await Promise.all([waitNode(first),waitNode(second),saved(first.tab),saved(second.tab)]);
  await append(first.tab,paragraphs[0],' — partagé');
  await expect(block(second.tab,paragraphs[0])).toContainText('partagé',{timeout});
  await saved(first.tab);
  console.log('Both real Chromium browsers negotiated the Node WebSocket and saw the first edit.');

  await owner.setOffline(true);
  await first.tab.evaluate(() => window.closeBrowserSmokeSockets());
  await expect(first.tab.locator('[data-desktop-status]')).toHaveAttribute('data-sync-state','offline',{timeout});
  await append(first.tab,paragraphs[0],' — hors ligne');
  await append(second.tab,paragraphs[1],' — confirmé');
  await saved(second.tab);
  const before = second.connected.size;
  await demo('compose','restart','room');
  await expect.poll(() => second.closed.size,{timeout}).toBeGreaterThan(0);
  await waitNode(second,before);
  await saved(second.tab);
  await expect(block(second.tab,paragraphs[1])).toContainText('confirmé',{timeout});
  assert.ok(!(await block(second.tab,paragraphs[0]).innerText()).includes('hors ligne'));
  const previous = first.connected.size;
  await owner.setOffline(false);
  await waitNode(first,previous);
  for (const {tab} of [first,second]) {
    await expect(block(tab,paragraphs[0])).toContainText('hors ligne',{timeout});
    await expect(block(tab,paragraphs[1])).toContainText('confirmé',{timeout});
    await saved(tab);
  }
  console.log('The online edit survived a room restart, and the offline edit reached both browsers on reconnect.');

  await Promise.all([first.tab.reload(), second.tab.reload()]);
  await Promise.all([saved(first.tab), saved(second.tab)]);
  // Fresh browser storage avoids satisfying persistence assertions from either editor’s local cache.
  const fresh = [];
  for (const [i,context] of [owner, editor].entries()) {
    const ctx = await browsers[i].newContext({baseURL, storageState:{cookies:await context.cookies(),origins:[]}});
    const trace = await roomTab(ctx);
    await waitNode(trace);
    await expect(block(trace.tab,paragraphs[0])).toContainText('hors ligne',{timeout});
    await expect(block(trace.tab,paragraphs[1])).toContainText('confirmé',{timeout});
    fresh.push(trace);
  }
  const persisted = await (await api(owner,'GET',pageAPI,200)).json();
  const storedBlocks = JSON.stringify(persisted.blocks);
  assert.ok(storedBlocks.includes('hors ligne') && storedBlocks.includes('confirmé'), 'Both edits should reach the API document projection');
  const memberTrace = fresh[1];
  const active = [...memberTrace.connected].filter(socket => !memberTrace.closed.has(socket));
  assert.ok(active.length > 0,'Expected an active member connection before revocation');
  await api(owner,'DELETE',grant,200);
  await expect.poll(() => active.every(socket => memberTrace.closed.has(socket)),
    {timeout,message:'Revoking the private share must close its active sockets'}).toBe(true);
  await api(editor,'GET',workspace+'/ticket?doc='+id,404);
  await api(editor,'GET',pageAPI,404);
  await api(owner,'GET',pageAPI,200);
  await api(owner,'PUT',grant,200,{level:'edit'});
  console.log('A clean reload restored both edits for both users. Revocation closed the live member socket and denied a new ticket; the share was restored.');
  console.log('Document: '+baseURL+path+'\nMailbox: '+mailbox+'\nWorkspace: '+workspaceName+'\nAccounts: '+ownerEmail+', '+editorEmail);
} finally {
  await Promise.all(browsers.map(browser=>browser.close()));
}
