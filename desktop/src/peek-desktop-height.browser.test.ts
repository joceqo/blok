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

it.each(['chromium', 'webkit'] as const)('keeps the side sheet below desktop tabs (%s)', async engine => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1352, height: 828 } });
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    localStorage.setItem('blok:database-peek-width', '875');
    const editor = new Blok({holder:document.querySelector('[data-desktop-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:DatabaseTool,'database-row':DatabaseRowTool},data:{blocks:[
      {id:'db',type:'database',content:['row'],data:{title:'Tenants',schema:[{id:'t',name:'Name',type:'title',position:'a0'}],views:[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],openPagesIn:'side'}],activeViewId:'v'}},
      {id:'row',type:'database-row',parent:'db',data:{properties:{t:'Tenant'},position:'a0'}}
    ]}});
    editor.isReady.then(()=>window.ready=true);
  `.replaceAll("'../src/", "'/@fs/" + resolve('..') + '/src/');
  try {
    await page.route(origin + '/', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto(origin + '/');
    await page.setContent(`<style>${readFileSync('src/shell.css','utf8')}</style>
      <div data-desktop-shell><header data-desktop-tabstrip><button>New tab</button></header>
      <main data-desktop-workspace><article data-desktop-document><div data-desktop-editor></div></article></main></div>`);
    await page.addScriptTag({type:'module',content:script});
    await page.waitForFunction(()=>Reflect.get(window,'ready')===true);
    await page.locator('[data-blok-database-table-row]').hover();
    await page.locator('[data-blok-database-table-open]').click();
    const drawer=page.locator('[data-blok-database-drawer][data-peek-mode="side"]');
    const backdrop=page.locator('[data-blok-database-peek-backdrop]');
    await page.waitForTimeout(350);
    for (const height of [828,600]) {
      await page.setViewportSize({width:1352,height});
      const tabs=await page.locator('[data-desktop-tabstrip]').boundingBox();
      const box=await drawer.boundingBox();
      const shield=await backdrop.boundingBox();
      if (!tabs || !box || !shield) throw new Error('Missing sheet geometry');
      expect(box.y).toBe(tabs.y+tabs.height);
      expect(box.y+box.height).toBe(height);
      expect(shield.y).toBe(box.y);
      expect(shield.height).toBe(box.height);
      expect(box.width).toBe(875);
    }
  } finally { await browser.close(); }
},45000);
