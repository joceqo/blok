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

it.each([['chromium','side'], ['webkit','side'], ['chromium','center'], ['webkit','center']] as const)('keeps the host page in place when a peek property is committed (%s, %s)', async (engine,mode) => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1512, height: 828 } });
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    const schema = [{id:'t',name:'Name',type:'title',position:'a0'},{id:'emoji',name:'emoji',type:'text',position:'a1'},{id:'note',name:'Note',type:'text',position:'a2'}];
    const view = {id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],properties:schema.map(p=>({id:p.id,visible:true,width:600})),openPagesIn:'${mode}'};
    const rows = Array.from({length:80},(_,i)=>({id:'r'+i,type:'database-row',parent:'db',data:{properties:{t:'Tenant '+i,emoji:''},position:'a'+String(i).padStart(3,'0')}}));
    const editor = new Blok({holder:document.querySelector('[data-desktop-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:DatabaseTool,'database-row':DatabaseRowTool},data:{blocks:[
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
    const canvas=page.locator('[data-desktop-page-canvas]');
    const row=page.locator('[data-blok-database-table-row][data-row-id="r30"]');
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await row.locator('[data-blok-database-table-open]').click();
    const value=page.locator('[data-blok-database-drawer-prop-value][data-property-id="emoji"]');
    const scroller=page.locator('[data-blok-database-table-scroller]');
    await scroller.evaluate(el=>{el.scrollLeft=137;});
    const before=await canvas.evaluate(el=>el.scrollTop);
    expect(before).toBeGreaterThan(500);
    expect(await scroller.evaluate(el=>el.scrollLeft)).toBe(137);
    for(const commit of ['Enter','Escape','outside','Tab']) {
      await value.click();
      const input=page.locator('[data-blok-database-cell-input="text"][aria-label="emoji"]:focus');
      const nextValue='favicon '+commit;
      await input.fill(nextValue);
      if(commit==='outside') {
        await page.locator('[data-blok-database-drawer-title]').click();
      } else {
        await input.press(commit);
      }
      await expect.poll(()=>value.textContent()).toContain(nextValue);
      await page.waitForTimeout(350); // Include async view/selection observers after commit.
      expect(await canvas.evaluate(el=>el.scrollTop),commit).toBeCloseTo(before,0);
      expect(await scroller.evaluate(el=>el.scrollLeft),commit).toBe(137);
      expect(await row.textContent()).toContain(nextValue);
      if(commit==='Tab') {
        const nextInput=page.locator('[data-blok-database-cell-input="text"][aria-label="Note"]:focus');
        await expect.poll(()=>nextInput.isVisible()).toBe(true);
        await nextInput.press('Escape');
      }
    }
  } finally {await browser.close();}
},45000);
