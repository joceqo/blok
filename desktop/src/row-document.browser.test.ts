// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';
import type { Workspace } from './workspace';

declare global { interface Window { rowDocumentFixture: Workspace } }
let server: ViteDevServer;
let browser: Browser;
let origin: string;
beforeAll(async () => {
  server = await createServer({configFile:resolve('vite.config.mjs'),server:{port:0,strictPort:false,host:'127.0.0.1',hmr:false},logLevel:'error'});
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel:'chrome'} : {});
});
afterAll(async () => { await browser?.close(); await server?.close(); });

it('opens a real body document, reloads edits, then edits the same content from its row peek', async () => {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().startsWith('[blok]')) errors.push(message.text()); });
  try {
    await page.route(url => url.origin === origin && url.pathname === '/', route => route.fulfill({contentType:'text/html',body:`<!doctype html><html><body>
      <div data-desktop-shell data-blok-theme="light" id="app"></div>
      <script type="module">
        import '/src/shell.css';
        import '/@fs/${resolve('../src/styles/main.css')}';
        import {createWorkspace} from '/src/workspace.ts';
        const prefix = 'blok:workspace:row-document-browser:';
        if (!localStorage.getItem(prefix + 'index')) {
          localStorage.setItem(prefix + 'index', JSON.stringify({pages:[{id:'parent',title:'Parent',parentId:null}],activeId:'parent'}));
          localStorage.setItem(prefix + 'row-bodies', JSON.stringify({body:{publicId:'11111111-1111-4111-8111-111111111111',documentId:'parent',rowId:'row',databaseId:'db',title:'My row'}}));
          localStorage.setItem(prefix + 'body', JSON.stringify({blocks:[{id:'text',type:'paragraph',data:{text:'Shared body content'}}]}));
          localStorage.setItem(prefix + 'parent', JSON.stringify({blocks:[
            {id:'db',type:'database',data:{schema:[{id:'t',name:'Name',type:'title',position:'a0'}],views:[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],visibleProperties:[],openPagesIn:'side'}],activeViewId:'v'},content:['row']},
            {id:'row',type:'database-row',parent:'db',data:{title:'My row',properties:{t:'My row'},pageId:'body',bodyBlocks:true,position:'a0'}}
          ]}));
        }
        const fixture = createWorkspace(()=>{},()=>{},{ref:{kind:'local',id:'row-document-browser',name:'Rows'}});
        window.rowDocumentFixture = fixture;
        window.addEventListener('popstate', () => fixture.onRoute());
        document.getElementById('app').append(fixture.element);
        await fixture.start();
      </script></body></html>`}));
    await page.goto(origin + '/?page=body&local=1');
    const title = page.locator('[data-desktop-editor] [data-blok-page-title]');
    await expect.poll(() => title.textContent()).toBe('My row');
    expect(await page.locator('[data-desktop-row-page]').count()).toBe(0);
    expect(await page.locator('[data-desktop-page-more]').isVisible()).toBe(true);
    const actions = await page.locator('[data-desktop-page-actions]').boundingBox();
    expect(actions?.width).toBeGreaterThan(0);
    await page.locator('[data-diagnostic-trigger]').click();
    await expect.poll(() => page.locator('[data-save-diagnostic] textarea').inputValue()).toContain('\"pageId\": \"body\"');
    await page.keyboard.press('Escape');
    await page.locator('[data-desktop-page-more]').click();
    await page.getByRole('button', {name:'Renommer',exact:true}).click();
    expect(await title.evaluate(el => document.activeElement === el)).toBe(true);
    await title.fill('Own document title');
    const body = page.locator('[data-blok-id="text"] [contenteditable="true"]').first();
    await body.fill('Edited from document');
    await page.evaluate(() => window.rowDocumentFixture.flush());
    const storedIndex = await page.evaluate(() => localStorage.getItem('blok:workspace:row-document-browser:index'));
    expect(JSON.parse(storedIndex ?? '{}')).toMatchObject({pages:[{id:'parent'}]});
    await page.reload();
    await expect.poll(() => title.textContent()).toBe('Own document title');
    await expect.poll(() => body.textContent()).toBe('Edited from document');
    await page.locator('[data-desktop-page-breadcrumb-item][data-page-id="parent"] button').click();
    await page.locator('[data-row-id="row"]').hover();
    await page.locator('[data-row-id="row"] [data-blok-database-table-open]').click();
    const peek = page.locator('[data-blok-database-drawer][data-peek-mode="side"]');
    const peekBody = peek.locator('[data-blok-id="text"] [contenteditable="true"]').first();
    await expect.poll(() => peekBody.textContent()).toBe('Edited from document');
    await expect.poll(() => peek.locator('[data-blok-database-drawer-title]').evaluate(el => el === document.activeElement)).toBe(true);
    await peekBody.click();
    await peekBody.fill('Edited from peek');
    await expect.poll(() => peekBody.textContent(), {message:'edit visible in peek before expand'}).toBe('Edited from peek');
    await page.locator('[data-blok-database-peek-expand]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('body');
    await expect.poll(() => body.textContent(), {message:'edit visible in document after expand'}).toBe('Edited from peek');
    expect(await page.locator('[data-desktop-page-more]').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    const stored = await page.evaluate(() => localStorage.getItem('blok:workspace:row-document-browser:body'));
    throw new Error(`${String(error)}; stored body: ${stored}; browser errors: ${errors.join('; ')}`);
  } finally { await page.close(); }
}, 60000);
