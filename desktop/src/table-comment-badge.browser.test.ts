// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
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

it.each(['chromium','webkit'] as const)('keeps table comment badges beside titles without adding a row line (%s)', async engine => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel:'chrome'} : {},
  );
  const page = await browser.newPage({viewport:{width:1000,height:900}});
  page.setDefaultTimeout(5000);
  const script = `
    import '/src/editor.css';
    import '/src/shell.css';
    import '../src/styles/lazy/database.css';
    import { DatabaseTableView } from '../src/tools/database/database-table-view.ts';
    import { refreshCommentBadges } from '../src/tools/database/database-comment-badge.ts';
    const labels={'tools.database.tableOpen':'Ouvrir','tools.database.tableClose':'Fermer','tools.database.openComments':'Ouvrir les commentaires','tools.database.tableSelectRow':'Sélectionner la ligne'};
    const i18n={t:key=>labels[key]??key};
    let count=1;
    window.opened=[];window.rowsOpened=[];
    const badges={databaseId:'db',count:id=>id==='plain'?0:count,open:id=>window.opened.push(id)};
    const schema=[{id:'t',name:'Title',type:'title',position:'a0'}];
    for(const wrap of [false,true]) {
      const table=new DatabaseTableView({readOnly:true,i18n,schema,titlePropertyId:'t',commentBadges:badges,
        openRow:id=>window.rowsOpened.push(id),
        view:{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],properties:[{id:'t',visible:true,width:280,wrap}]},
        rows:[{id:'commented',position:'a0',icon:'🏢',properties:{t:'Finsbury'}},{id:'plain',position:'a1',icon:'🏢',properties:{t:'Finsbury'}},{id:'long',position:'a2',icon:'🏢',properties:{t:'Fizzy Retail [A very long tenant name which wraps onto several lines]'}}]
      });
      const host=document.createElement('section');host.setAttribute('data-example',String(wrap));host.append(table.createView());document.querySelector('[data-blok-database-wrapper]').append(host);
    }
    window.setCount=n=>{count=n;refreshCommentBadges(document,badges,i18n);};
    window.ready=true;
  `.replaceAll("'../src/", "'/@fs/"+resolve('..')+'/src/');
  try {
    await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body data-blok-theme="dark"><div data-blok-interface><div data-blok-editor><div data-blok-database-wrapper></div></div></div></body></html>'}));
    await page.goto(origin+'/');
    await page.addScriptTag({type:'module',content:script});
    await page.waitForFunction(()=>Reflect.get(window,'ready')===true);
    await page.screenshot({path:'/tmp/blok-table-comment-badge.png'});
    const measure=async (wrap:boolean,id:string)=>page.locator(`[data-example="${wrap}"] [data-row-id="${id}"] [data-type="title"]`).evaluate(cell=>{
      const title=cell.querySelector<HTMLElement>('[data-blok-database-cell]');
      const badge=cell.querySelector<HTMLElement>('[data-blok-database-comment-badge]');
      if(!title)throw Error('Missing title');
      const box=cell.getBoundingClientRect(),text=title.getBoundingClientRect(),count=badge?.getBoundingClientRect();
      return {height:box.height,titleY:text.y,badgeY:count?.y,badgeX:count?.x,titleWidth:text.width,badgeRight:count?.right,right:box.right,truncated:title.scrollWidth>title.clientWidth};
    });
    for(const wrap of [false,true]) {
      const plain=await measure(wrap,'plain');
      const commented=await measure(wrap,'commented');
      expect(commented.height).toBeCloseTo(plain.height,0);
      expect(commented.badgeY).toBeCloseTo(commented.titleY,0);
      const long=await measure(wrap,'long');
      expect(long.badgeY).toBeCloseTo(long.titleY,0);
      expect(long.badgeRight).toBeLessThan(long.right);
      if(wrap)expect(long.height).toBeGreaterThan(plain.height);
      else {expect(long.height).toBeCloseTo(plain.height,0);expect(long.truncated).toBe(true);}
    }
    // A hidden hover action must not consume the title's wrapping width.
    const wrappedWidth = await page.locator('[data-example="true"] [data-row-id="long"] [data-type="title"]').evaluate(cell => {
      const title = cell.querySelector<HTMLElement>('[data-blok-database-cell]')!;
      const open = cell.querySelector<HTMLElement>('[data-blok-database-table-open]')!;
      const before = title.getBoundingClientRect().width;
      open.style.display = 'none';
      const withoutAction = title.getBoundingClientRect().width;
      open.style.removeProperty('display');
      return { before, withoutAction };
    });
    expect(wrappedWidth.before).toBeCloseTo(wrappedWidth.withoutAction, 0);
    await page.locator('[data-example="false"] [data-row-id="commented"] [data-blok-database-comment-badge]').click();
    for(const wrap of [false,true]) {
      const longBadge=page.locator(`[data-example="${wrap}"] [data-row-id="long"] [data-blok-database-comment-badge]`);
      await page.mouse.move(990, 890);
      const beforeHover = await measure(wrap, 'long');
      await page.locator(`[data-example="${wrap}"] [data-row-id="long"]`).hover();
      const afterHover = await measure(wrap, 'long');
      expect(afterHover.badgeX).toBeCloseTo(beforeHover.badgeX!, 0);
      expect(afterHover.titleWidth).toBeCloseTo(beforeHover.titleWidth, 0);
      await page.screenshot({path:`/tmp/blok-table-comment-badge-${engine}-${wrap}.png`});
      await longBadge.click({timeout:4000});
    }
    expect(await page.evaluate(()=>Reflect.get(window,'opened'))).toEqual(['commented','long','long']);
    expect(await page.evaluate(()=>Reflect.get(window,'rowsOpened'))).toEqual([]);
    await page.locator('[data-example="true"] [data-row-id="long"] [data-blok-database-table-open]').click();
    expect(await page.evaluate(()=>Reflect.get(window,'rowsOpened'))).toEqual(['long']);
    for(const count of [0,12]) {
      await page.evaluate(n=>Reflect.get(window,'setCount')(n),count);
      expect((await measure(false,'commented')).height).toBeCloseTo((await measure(false,'plain')).height,0);
    }
  } finally {await browser.close();}
},45000);
