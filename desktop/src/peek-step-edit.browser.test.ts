// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, webkit } from 'playwright';

let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
  server = await createServer({ configFile: resolve('vite.config.mjs'), server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await server?.close(); });

it.each([['chromium','side'], ['webkit','side'], ['chromium','center'], ['webkit','center']] as const)('keeps the peek open when editing after next and previous row navigation (%s, %s)', async (engine,mode) => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1512, height: 828 } });
  const script = `
    import { Blok } from '../src/blok.ts';
    import { mountPeekDiagnostics } from '/src/peek-diagnostics.ts';
    mountPeekDiagnostics();
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    const schema = [{id:'t',name:'Name',type:'title',position:'a0'},{id:'emoji',name:'emoji',type:'text',position:'a1'},{id:'note',name:'Note',type:'text',position:'a2'}];
    const view = {id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],properties:schema.map(p=>({id:p.id,visible:true,width:600})),openPagesIn:'${mode}'};
    const rows = Array.from({length:80},(_,i)=>({id:'r'+i,type:'database-row',parent:'db',data:{properties:{t:'Tenant '+i,emoji:''},position:'a'+String(i).padStart(3,'0')}}));
    const editor = new Blok({holder:document.querySelector('[data-desktop-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:DatabaseTool,'database-row':DatabaseRowTool},data:{blocks:[
      {id:'intro',type:'paragraph',data:{text:'Host page introduction'}},
      {id:'db',type:'database',content:rows.map(r=>r.id),data:{title:'Tenants',schema,views:[view],activeViewId:'v'}},...rows
    ]}});
    window.editor=editor;editor.isReady.then(()=>window.ready=true);
  `.replaceAll("'../src/", "'/@fs/" + resolve('..') + '/src/');
  try {
    await page.route(origin + '/', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto(origin + '/');
    await page.setContent(`<style>${readFileSync('src/shell.css','utf8')}</style><style>
      body {margin:0} [data-desktop-page-canvas] {margin-left:260px;width:1252px;height:828px;overflow:auto}
    </style><main data-desktop-page-canvas><article data-desktop-document><div data-desktop-editor></div></article></main>`);
    await page.addScriptTag({type:'module',content:script});
    await page.waitForFunction(()=>Reflect.get(window,'ready')===true);
    const row=page.locator('[data-blok-database-table-row][data-row-id="r30"]');
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await row.locator('[data-blok-database-table-open]').click();
    const drawer=page.locator('[data-blok-database-drawer][data-open]');
    const title=drawer.locator('[data-blok-database-drawer-title]');
    const firstValue=drawer.locator('[data-blok-database-drawer-prop-value][data-property-id="emoji"]');
    await firstValue.click();
    await drawer.locator('[data-blok-database-row-empty]').click();
    await drawer.locator('[data-blok-database-row-body] [contenteditable="true"]').waitFor({state:'visible'});
    await firstValue.click();
    await expect.poll(()=>drawer.count()).toBe(1);
    await page.locator('[data-blok-database-cell-input="text"][aria-label="emoji"]:focus').press('Escape');

    for (const [direction, rowNumber] of [['next',31],['next',32],['prev',31],['prev',30]] as const) {
      await drawer.locator(`[data-blok-database-peek-${direction}]`).click();
      await expect.poll(()=>title.inputValue()).toBe('Tenant '+rowNumber);
      const value=drawer.locator('[data-blok-database-drawer-prop-value][data-property-id="emoji"]');
      await value.click();
      const input=page.locator('[data-blok-database-cell-input="text"][aria-label="emoji"]:focus');
      await input.fill('Edited '+rowNumber);
      // Leave the edit open: the next chevron must commit it before changing rows.
      await expect.poll(()=>drawer.count()).toBe(1);
      expect(await title.inputValue()).toBe('Tenant '+rowNumber);
    }
    // Finish the last editor before testing the peek's own dismissal. A click
    // with a cell popover open first belongs to that popover's outside handling.
    await page.locator('[data-blok-database-cell-input="text"][aria-label="emoji"]:focus').press('Enter');
    await expect.poll(()=>firstValue.textContent()).toContain('Edited 30');
    await page.locator('[data-blok-database-peek-backdrop]').click({position:{x:5,y:5}});
    await expect.poll(()=>drawer.count()).toBe(0);
    const closures=await page.evaluate(()=>JSON.parse(localStorage.getItem('blok:peek-dismissals') ?? '[]'));
    expect(closures).toHaveLength(1);
    expect(closures[0]).toMatchObject({reason:'backdrop',mode});
  } catch (error) {
    console.error('Peek dismissal diagnostics',await page.evaluate(()=>localStorage.getItem('blok:peek-dismissals')));
    throw error;
  } finally {await browser.close();}
},45000);
