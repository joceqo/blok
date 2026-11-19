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

it.each(['chromium', 'webkit'] as const)('appends two table batches without rebuilding or moving the canvas (%s)', async engine => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1512, height: 828 } });
  page.setDefaultTimeout(5000);
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    const schema = [{id:'t',name:'Name',type:'title',position:'a0'},{id:'note',name:'Note',type:'text',position:'a1'}];
    const view = {id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],loadLimit:10,properties:schema.map(p=>({id:p.id,visible:true,width:800}))};
    const rows = Array.from({length:25},(_,i)=>({id:'r'+i,type:'database-row',parent:'db',data:{properties:{t:'Tenant '+i,note:'Details'},position:'a'+String(i).padStart(3,'0')}}));
    const paragraphs = prefix => Array.from({length:25},(_,i)=>({id:prefix+i,type:'paragraph',data:{text:'Paragraph '+i}}));
    const editor = new Blok({holder:document.querySelector('[data-desktop-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:DatabaseTool,'database-row':DatabaseRowTool},data:{blocks:[
      ...paragraphs('before'),{id:'db',type:'database',content:rows.map(r=>r.id),data:{title:'Tenants',schema,views:[view],activeViewId:'v'}},...rows,...paragraphs('after')
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
    const scroller=page.locator('[data-blok-database-table-scroller]');
    await page.evaluate(()=>{
      Reflect.set(window,'initialTable',document.querySelector('[data-blok-database-table]'));
      Reflect.set(window,'initialRow',document.querySelector('[data-blok-database-table-row]'));
    });
    for(const expected of [20,25]) {
      const more=page.locator('[data-blok-database-table-load-more]');
      await more.scrollIntoViewIfNeeded();
      await scroller.evaluate(el=>{el.scrollLeft=137;});
      const before=await canvas.evaluate(el=>el.scrollTop);
      expect(before).toBeGreaterThan(200);
      await more.click({position:{x:200,y:12}});
      await expect.poll(()=>page.locator('[data-blok-database-table-row]').count()).toBe(expected);
      await page.waitForTimeout(200); // Includes scroll anchoring and editor observers.
      expect(await canvas.evaluate(el=>el.scrollTop)).toBeCloseTo(before,0);
      expect(await scroller.evaluate(el=>el.scrollLeft)).toBe(137);
      expect(await page.evaluate(()=>document.querySelector('[data-blok-database-table]')===Reflect.get(window,'initialTable'))).toBe(true);
      expect(await page.evaluate(()=>document.querySelector('[data-blok-database-table-row]')===Reflect.get(window,'initialRow'))).toBe(true);
    }
    expect(await page.locator('[data-blok-database-table-load-more]').count()).toBe(0);
    const last=page.locator('[data-blok-database-table-row][data-row-id="r24"]');
    await last.scrollIntoViewIfNeeded();
    await last.hover();
    await last.locator('[data-blok-database-table-open]').click();
    await expect.poll(()=>page.locator('[data-blok-database-drawer-title]').inputValue()).toBe('Tenant 24');
  } finally { await browser.close(); }
},45000);
