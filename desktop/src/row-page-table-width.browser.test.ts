// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
  server = await createServer({ configFile: resolve('vite.config.mjs'), server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
});
afterAll(async () => { await browser?.close(); await server?.close(); });

it('paints and scrolls a real full-page row table all the way to the canvas edge', async () => {
  const page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  page.setDefaultTimeout(15000);
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    const schema = [{id:'t',name:'Name',type:'title',position:'a0'}, ...Array.from({length:7},(_,i)=>({id:'p'+i,name:'Property '+i,type:'text',position:'a'+(i+1)}))];
    const view = {id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],visibleProperties:schema.map(p=>p.id)};
    const editor = new Blok({holder:document.querySelector('[data-desktop-editor]'), dataModel:'hierarchical', tools:{paragraph:Paragraph,database:DatabaseTool,'database-row':DatabaseRowTool}, data:{blocks:[
      {id:'db',type:'database',data:{schema,views:[view],activeViewId:'v'},content:['r1']},
      {id:'r1',type:'database-row',parent:'db',content:['nested'],data:{properties:{t:'Sprint 14'},position:'a0',bodyBlocks:true}},
      {id:'nested',type:'database',parent:'r1',content:['n1'],data:{title:'Tasks',schema,views:[view],activeViewId:'v'}},
      {id:'n1',type:'database-row',parent:'nested',data:{properties:{t:'Task',p0:'First property'},position:'a0'}}
    ]}});
    window.editor=editor;
    editor.isReady.then(()=>{editor.blocks.getById('db').call('openRow',{rowId:'r1',mode:'full',explicit:true});window.ready=true;});
  `.replaceAll("'../src/", "'/@fs/" + resolve('..') + '/src/');
  try {
    await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto(origin + '/');
    await page.setContent(`<style>${readFileSync('src/shell.css', 'utf8')}</style><style>
      [data-desktop-page-canvas] { margin-left: 260px; width: 1252px; height: 1000px; overflow: auto; }
    </style><main data-desktop-page-canvas><article data-desktop-document><div data-desktop-editor></div></article></main>`);
    await page.addScriptTag({ type: 'module', content: script });
    await page.waitForFunction(() => Boolean((window as unknown as { ready?: boolean }).ready));
    const drawer = page.locator('[data-blok-database-drawer][data-peek-mode="full"]');
    const scroller = drawer.locator('[data-blok-database-table-scroller]');
    await scroller.waitFor({ state: 'visible' });
    const canvas = page.locator('[data-desktop-page-canvas]');
    const canvasBox = (await canvas.boundingBox())!;
    const tableBox = (await scroller.boundingBox())!;
    // A full-sized bounding box is not proof of visible overflow: the old
    // drawer still clipped it. Hit-test the real cells outside the text column.
    const edge = { x: canvasBox.x + canvasBox.width - 20, y: tableBox.y + 50 };
    const cellAtEdge = () => page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-blok-database-table-grid]')), edge);
    await expect.poll(cellAtEdge).toBe(true);
    expect(tableBox.width).toBeCloseTo(canvasBox.width, 0);
    expect(tableBox.x).toBeCloseTo(canvasBox.x, 0);
    await scroller.evaluate(el => { el.scrollLeft = 240; });
    expect(await scroller.evaluate(el => el.scrollLeft)).toBe(240);
    expect(await canvas.evaluate(el => el.scrollLeft)).toBe(0);
    expect(await canvas.evaluate(el => el.scrollWidth)).toBe(1252);
    await expect.poll(cellAtEdge).toBe(true);
    if (process.env.BLOK_WIDTH_SCREENSHOT) await page.screenshot({ path: '/tmp/blok-row-table-width.png' });

    // The fix is specific to full pages; floating peeks still clip their body.
    for (const mode of ['side', 'center']) {
      await page.evaluate(mode => {
        const editor = (window as unknown as { editor: { blocks: { getById(id: string): { call(name: string, options: unknown): void } } } }).editor;
        editor.blocks.getById('db').call('openRow', { rowId: 'r1', mode, explicit: true });
      }, mode);
      const peek = page.locator(`[data-blok-database-drawer][data-peek-mode="${mode}"]`);
      await expect.poll(() => peek.evaluate(el => getComputedStyle(el).overflow)).toBe('hidden');
      expect((await peek.boundingBox())!.width).toBeLessThan(canvasBox.width);
    }
  } finally { await page.close(); }
}, 45000);
