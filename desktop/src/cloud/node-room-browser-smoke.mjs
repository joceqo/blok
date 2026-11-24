// The launcher creates an isolated Compose project with loopback ports and the local mailbox.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const workspaceMode = process.env.BLOK_ROOM_SMOKE_WORKSPACE === '1';
const id = randomUUID();
const newPage = randomUUID();
const outsidePage = randomUUID();
const slug = 'browser-' + id.slice(0, 8);
const ownerEmail = 'admin@example.test', editorEmail = 'editor@example.test';
const workspace = '/api/workspaces/' + slug;
const workspaceName = 'Collaboration Node ' + slug;
const path = '/?page=' + id;
const pageAPI = workspace + '/pages/' + id;
// The provider reports connected before read-only arbitration and the first document render finish.
const editorSelector = '[data-blok-instance]:not([aria-busy="true"]) [data-blok-redactor] [contenteditable="true"]';
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
async function roomTab(context, documentId = id, name = workspaceName) {
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
  const targets = new Set(), connected = new Set(), closed = new Set(), go = new Set();
  const nodeTickets = new Set();
  cdp.on('Network.responseReceived', ({requestId,response}) => {
    const url = new URL(response.url);
    if (!url.pathname.endsWith('/ticket') || url.searchParams.get('doc') !== documentId || response.status !== 200) return;
    if (Object.entries(response.headers).some(([key,value]) => key.toLowerCase() === 'x-blok-ticket-backend' && value === 'node')) {
      nodeTickets.add(requestId);
    }
  });
  cdp.on('Network.webSocketCreated', event => {
    if (new URL(event.url).pathname === '/api/blok/sync/' + documentId) targets.add(event.requestId);
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', ({requestId,response}) => {
    if (!targets.has(requestId) || response.status !== 101) return;
    const marker = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'x-blok-collaboration');
    if (String(marker?.[1]).toLowerCase() === 'node') connected.add(requestId);
    else if (!marker) go.add(requestId);
  });
  cdp.on('Network.webSocketClosed', ({requestId}) => { if (connected.has(requestId)) closed.add(requestId); });
  await cdp.send('Network.enable');
  const session = await (await api(context,'GET','/api/session',200)).json();
  await tab.goto('/?cloud=1');
  if (session.workspaces.length > 1) {
    const row = tab.locator('[data-cloud-row]').filter({has:tab.getByText(name,{exact:true})});
    await row.getByRole('button',{name:'Ouvrir l’espace'}).click({timeout});
  }
  await expect(tab.locator('[data-blok-sidebar]')).toBeVisible({timeout});
  if (new URL(tab.url()).searchParams.get('page') !== documentId) await tab.goto('/?page='+documentId);
  return { tab, connected, closed, go, nodeTickets };
}
const saved = page => expect(page.locator('[data-desktop-status]')).toHaveAttribute('data-sync-state','connected',{timeout});
const waitNode = (trace, previous = 0) => expect.poll(() => trace.connected.size,
  {timeout,message:'Expected a new 101 from the Node room on the selected document'}).toBeGreaterThan(previous);
async function append(page, needle, suffix) {
  const field = block(page, needle);
  await expect(field).toBeEditable({timeout});
  await field.click();
  await expect(field).toBeFocused({timeout});
  await field.press('End');
  await field.pressSequentially(suffix);
  await expect(field).toContainText(suffix,{timeout});
}

async function addPrivatePage(owner, base, documentId, title) {
  const index = await (await api(owner,'GET',base+'/index',200)).json();
  await api(owner,'PUT',base+'/index',200,{revision:index.revision,pages:[
    ...index.pages, {id:documentId,title,parentId:null,initialVisibility:'private'},
  ],trash:index.trash});
}

async function browserContext(browser, source) {
  return browser.newContext({baseURL,storageState:{cookies:await source.cookies(),origins:[]}});
}

async function nodeTicket(context, url) {
  const response = await api(context,'GET',url,200);
  assert.equal(response.headers()['x-blok-ticket-backend'],'node','The public ticket must come from the Node service');
  return (await response.json()).ticket;
}

function probeRoom(fields) {
  // Tickets travel over stdin. The ACL callback uses the secret already held by the room container.
  const script = readFileSync(new URL('./workspace-room-probe.mjs',import.meta.url),'utf8');
  const res = spawnSync('./deploy/demo.sh',['compose','exec','-T','room','node','--input-type=module','-e',script],{
    input:JSON.stringify({...fields,origin:baseURL}), encoding:'utf8', timeout:15000,
  });
  assert.equal(res.status,0,'Local room probe failed: '+res.stderr);
  return JSON.parse(res.stdout);
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
  await addPrivatePage(owner,workspace,id,'Collaboration Node');
  const outsideSlug = 'other-' + slug;
  const outsideName = 'Autre espace ' + slug;
  const outside = '/api/workspaces/' + outsideSlug;
  if (workspaceMode) {
    await api(owner,'POST','/api/workspaces',201,{slug:outsideSlug,name:outsideName});
    await addPrivatePage(owner,outside,outsidePage,'Page hors migration');
  }
  const paragraphs = ['Ligne propriétaire','Ligne éditeur'];
  const blocks = paragraphs.map((text, i) => ({ id: 'line-'+(i+1), type:'paragraph', data:{text} }));
  await api(owner,'POST',pageAPI+'/seed',200,{document:{blocks}});
  await api(editor,'GET',pageAPI,404);
  const grant = pageAPI + '/shares/' + encodeURIComponent(member.user.id);
  await api(owner,'PUT',grant,200,{level:'edit'});
  console.log('Created a private document and granted editor access.');
  const [first,second] = await Promise.all([roomTab(owner),roomTab(editor)]);
  await Promise.all([waitNode(first),waitNode(second),saved(first.tab),saved(second.tab)]);
  // An HTTP/WS connection can finish before the peer has mounted the shared paragraph.
  await expect(block(second.tab,paragraphs[0])).toBeEditable({timeout});
  await append(first.tab,paragraphs[0],' — partagé');
  await expect(block(second.tab,paragraphs[0])).toContainText('partagé',{timeout});
  await saved(first.tab);
  await expect(first.tab.locator('[data-desktop-page-peers]')).toBeVisible({timeout});
  await expect(second.tab.locator('[data-desktop-page-peers]')).toBeVisible({timeout});
  await first.tab.getByRole('button',{name:'Actions de la page'}).click();
  await first.tab.getByRole('button',{name:'Historique des versions'}).click();
  const historyPanel=first.tab.locator('[data-desktop-history]');
  await expect(historyPanel.locator('[data-history-preview]')).toContainText('partagé',{timeout});
  await historyPanel.getByText('Modifications de cette version',{exact:true}).click({timeout});
  await expect(historyPanel.locator('[data-history-details] li').first()).toContainText('Modification',{timeout});
  await historyPanel.getByLabel('Version à consulter').selectOption({index:1});
  await expect(historyPanel.locator('[data-history-preview]')).toContainText(paragraphs[0],{timeout});
  await expect(historyPanel.locator('[data-history-preview]')).not.toContainText('partagé',{timeout});
  await expect(historyPanel.getByRole('button',{name:'Restaurer cette version'})).toBeVisible({timeout});
  await historyPanel.getByRole('button',{name:'Fermer'}).click();
  console.log('Both clients saw their peer; the shell read the current and initial version.');
  console.log('Both real Chromium browsers negotiated the Node WebSocket and saw the first edit.');

  let additional;
  if (workspaceMode) {
    // A newly created empty page has no Go seed or journal when its first client connects.
    await addPrivatePage(owner,workspace,newPage,'Page créée après activation');
    const grantNew = workspace+'/pages/'+newPage+'/shares/'+encodeURIComponent(member.user.id);
    await api(owner,'PUT',grantNew,200,{level:'edit'});
    const ctx = await browserContext(browsers[1],editor);
    additional = await roomTab(ctx,newPage);
    await waitNode(additional);
    await saved(additional.tab);
    for (const trace of [first,second,additional]) assert.ok(trace.nodeTickets.size > 0,'The shell must obtain its live ticket from Node');
    // First sync creates the empty paragraph on this brand-new document.
    // Wait for its durable projection before targeting that block in the browser.
    const pageUrl = workspace+'/pages/'+newPage;
    const blockId = async () => {
      const response = await (await api(editor,'GET',pageUrl,200)).json();
      return response?.blocks?.[0]?.id;
    };
    await expect.poll(blockId,{timeout,message:'Expected the first paragraph to finish synchronizing'}).toBeTruthy();
    const paragraphId = await blockId();
    const field = additional.tab.locator('[data-blok-id="'+paragraphId+'"]').locator('[contenteditable="true"]').first();
    await expect(field).toBeEditable({timeout});
    await field.click();
    await expect(field).toBeFocused({timeout});
    await field.pressSequentially('Deuxième journal avant redémarrage');
    await expect(field).toContainText('Deuxième journal',{timeout});
    await saved(additional.tab);
    const session = await (await api(owner,'GET','/api/session',200)).json();
    const selected = session.workspaces.find(entry => entry.slug === slug).id;
    const other = session.workspaces.find(entry => entry.slug === outsideSlug).id;
    const selectedTicket = await nodeTicket(editor,workspace+'/ticket?doc='+newPage);
    const foreignTicket = await nodeTicket(owner,'/api/blok-ticket?doc='+outsidePage);
    const checks = probeRoom({selected,other,newPage,outsidePage,selectedTicket,foreignTicket});
    assert.equal(checks.workspaceId,selected);
    assert.equal(checks.foreignId,other);
    assert.deepEqual(checks.allowed,{read:true,write:true});
    assert.ok([401,403].includes(checks.foreignRoomStatus),'A ticket from the other workspace must be refused for this page');
    const outsideContext = await browserContext(browsers[0],owner);
    const outsideTab = await roomTab(outsideContext,outsidePage,outsideName);
    await waitNode(outsideTab);
    await outsideContext.close();
    console.log('Both workspaces upgraded through Node. Tickets remain bound to the authorized document.');
  }

  await owner.setOffline(true);
  await first.tab.evaluate(() => window.closeBrowserSmokeSockets());
  await expect(first.tab.locator('[data-desktop-status]')).toHaveAttribute('data-sync-state','offline',{timeout});
  await append(first.tab,paragraphs[0],' — hors ligne');
  await append(second.tab,paragraphs[1],' — confirmé');
  await saved(second.tab);
  const before = second.connected.size;
  const beforeAdditional = additional?.connected.size;
  await demo('compose','restart','room');
  await expect.poll(() => second.closed.size,{timeout}).toBeGreaterThan(0);
  await waitNode(second,before);
  await saved(second.tab);
  if (additional) {
    await waitNode(additional,beforeAdditional);
    await saved(additional.tab);
    const clean = await browserContext(browsers[0],owner);
    const restored = await roomTab(clean,newPage);
    await waitNode(restored);
    await expect(block(restored.tab,'Deuxième journal')).toContainText('avant redémarrage',{timeout});
    const stored = await (await api(owner,'GET',workspace+'/pages/'+newPage,200)).json();
    assert.ok(JSON.stringify(stored.blocks).includes('Deuxième journal avant redémarrage'));
    await clean.close();
  }
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
  const beforeRevoke = additional && await nodeTicket(editor,workspace+'/ticket?doc='+id);
  await api(owner,'DELETE',grant,200);
  await expect.poll(() => active.every(socket => memberTrace.closed.has(socket)),
    {timeout,message:'Revoking the private share must close its active sockets'}).toBe(true);
  await api(editor,'GET',workspace+'/ticket?doc='+id,404);
  await api(editor,'GET',pageAPI,404);
  await api(owner,'GET',pageAPI,200);
  if (additional) {
    assert.deepEqual(probeRoom({documentId:id,revokedTicket:beforeRevoke}),{read:false,write:false});
    assert.equal((await api(editor,'GET','/api/blok-ticket?doc='+id,403)).headers()['x-blok-ticket-backend'],'node');
    await nodeTicket(editor,workspace+'/ticket?doc='+newPage);
    await saved(additional.tab);
  }
  await api(owner,'PUT',grant,200,{level:'edit'});
  console.log('A clean reload restored both edits for both users. Revocation closed the live member socket and denied a new ticket; the share was restored.');
  if (additional) {
    const disposable = randomUUID();
    const title = 'Page jetable de la recette';
    await addPrivatePage(owner,workspace,disposable,title);
    const data = {blocks:[{id:'fixture',type:'paragraph',data:{text:'Avant réinitialisation'}}]};
    await api(owner,'POST',workspace+'/pages/'+disposable+'/seed',200,{document:data});
    const token = await nodeTicket(owner,workspace+'/ticket?doc='+disposable);
    const headers = {Authorization:'Bearer '+token,Origin:baseURL};
    const sync='/api/blok/sync/'+disposable;
    const before = await owner.request.get(sync+'/state',{headers});
    assert.equal(before.status(),200);
    const reset=await owner.request.post(sync+'/reset',{headers});
    assert.equal(reset.status(),204,'Reset must rebaseline the canonical record');
    const after=await owner.request.get(sync+'/state',{headers});
    assert.equal(after.status(),200);
    assert.notEqual(before.headers()['blok-doc-lineage'],after.headers()['blok-doc-lineage']);
    assert.deepEqual((await after.json()).blocks,(await before.json()).blocks);
    const index=await (await api(owner,'GET',workspace+'/index',200)).json();
    await api(owner,'PUT',workspace+'/index',200,{revision:index.revision,pages:index.pages.filter(p=>p.id!==disposable),
      trash:[...index.trash,index.pages.find(p=>p.id===disposable)]});
    const tab=await owner.newPage();
    await tab.goto('/?page='+id);
    await tab.locator('[data-blok-sidebar-teamspace-more]').first().click({timeout});
    await tab.locator('[data-blok-item-name="trash"]').click({timeout});
    const trash=tab.locator('[data-workspace-trash]');
    await trash.getByRole('button',{name:'Supprimer définitivement « '+title+' »',exact:true}).click({timeout});
    await trash.getByRole('button',{name:'Supprimer définitivement',exact:true}).click({timeout});
    await expect(trash.getByRole('status')).toContainText('a été supprimée',{timeout});
    assert.equal((await owner.request.get(sync+'/history',{headers})).status(),403);
    const stored=await demo('compose','exec','-T','postgres','psql','-U','blok','-d','blok','-Atc',
      "SELECT deleted AND content IS NULL AND metadata='{}'::jsonb AND completed_at IS NOT NULL FROM pages JOIN page_purge_requests ON page_id=id WHERE id='"+disposable+"'");
    assert.equal(stored.stdout.trim(),'t');
    await tab.close();
    console.log('Reset preserved the page contents in a new lineage. Permanent deletion from the trash removed its journal and canonical projection.');
  }
  if (additional) console.log('Second Node document: '+baseURL+'/?page='+newPage);
  console.log('Document: '+baseURL+path+'\nMailbox: '+mailbox+'\nWorkspace: '+workspaceName+'\nAccounts: '+ownerEmail+', '+editorEmail);
} finally {
  await Promise.all(browsers.map(browser=>browser.close()));
}
