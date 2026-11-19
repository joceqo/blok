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

it.each(['chromium', 'webkit'] as const)('matches nested table headers to the sheet surface (%s)', async engine => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1352, height: 828 } });
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';

    const editor = new Blok({holder:document.querySelector('[data-desktop-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:DatabaseTool,'database-row':DatabaseRowTool},data:{blocks:[
      {id:'db',type:'database',content:['row'],data:{title:'Tenants',schema:[{id:'t',name:'Name',type:'title',position:'a0'}],views:[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],openPagesIn:'side'}],activeViewId:'v'}},
      {id:'row',type:'database-row',parent:'db',content:['nested'],data:{properties:{t:'Tenant'},position:'a0'}},
      {id:'nested',type:'database',parent:'row',data:{title:'Tasks',schema:[{id:'t',name:'Name',type:'title',position:'a0'}],views:[{id:'nv',name:'Table',type:'table',position:'a0',sorts:[],filters:[]}],activeViewId:'nv'}}
    ]}});
    window.editor=editor; editor.isReady.then(()=>window.ready=true);
  `.replaceAll("'../src/", "'/@fs/" + resolve('..') + '/src/');
  try {
    await page.route(origin + '/', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto(origin + '/');
    await page.setContent(`<style>${readFileSync('src/shell.css','utf8')}</style>
      <div data-desktop-shell data-blok-theme="dark"><header data-desktop-tabstrip><button>New tab</button></header>
      <main data-desktop-workspace><article data-desktop-document><div data-desktop-editor></div></article></main></div>`);
    await page.addScriptTag({type:'module',content:script});
    await page.waitForFunction(()=>Reflect.get(window,'ready')===true);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.querySelector('[data-desktop-shell]')?.setAttribute('data-blok-theme', theme);
        document.querySelectorAll('[data-blok-interface]').forEach(el=>el.setAttribute('data-blok-theme',theme));
      },theme);
      for (const mode of ['side','center','full']) {
        await page.evaluate(mode=>{
          const editor=Reflect.get(window,'editor');
          editor.blocks.getById('db').call('openRow',{rowId:'row',mode,explicit:true});
        },mode);
        const header=page.locator('[data-blok-database-drawer] [data-blok-database-table-header]').last();
        await header.waitFor({state:'visible'});
        const colors=await header.evaluate(el=>{
          const drawer=el.closest('[data-blok-database-drawer]');
          if (!drawer) throw new Error('Missing drawer');
          const surface=modeColor(drawer);
          function modeColor(drawer:Element): string {
            if (drawer.getAttribute('data-peek-mode')!=='full') return getComputedStyle(drawer).backgroundColor;
            return getComputedStyle(document.querySelector('[data-desktop-shell]') as Element).backgroundColor;
          }
          return {surface,header:getComputedStyle(el).backgroundColor,
            cells:Array.from(el.querySelectorAll('[data-blok-database-table-column-header]')).map(cell=>getComputedStyle(cell).backgroundColor)};
        });
        expect(colors.header,theme+' '+mode).toBe(colors.surface);
        expect(colors.cells.length).toBeGreaterThan(0);
        for (const color of colors.cells) expect(color,theme+' '+mode).toBe(colors.surface);
      }
    }
  } finally { await browser.close(); }
},45000);
