// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
  server = await createServer({configFile:resolve('vite.config.mjs'),server:{port:0,strictPort:false,host:'127.0.0.1',hmr:false},logLevel:'error'});
  await server.listen();
  const address=server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  origin=`http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel:'chrome'} : {});
});
afterAll(async () => { await browser?.close(); await server?.close(); });

it('opens a cold nested row, expands its peek, and follows real Back/Forward without changing the destination', async () => {
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    import { openRowRoute } from '/src/row-route.ts';
    let editor, pending, path=[], closingPath=false;
    const route=()=>{const p=new URL(location.href).searchParams;return p.has('row')?{rowId:p.get('row'),databaseId:p.get('database')||undefined}:null;};
    const show=async()=>{
      pending?.abort();pending=new AbortController();
      closingPath=true;
      try{for(const step of [...path].reverse())step.database.call('closeRow');path=[];}
      finally{closingPath=false;}
      const current=route();
      if(!current){document.title='Sprints';return;}
      const row=editor.blocks.getById(current.rowId),db=editor.blocks.getById(current.databaseId||row?.parentId);
      if(!row||!db){document.title='Unavailable';return;}
      path=await openRowRoute(editor.blocks,row,db,pending.signal);
      document.title=document.querySelector('[data-blok-database-drawer][data-peek-mode="full"]:not([data-blok-database-full-page]) [data-blok-database-drawer-title]')?.value||'Missing row';
    };
    const go=(rowId,context)=>{history.pushState(null,'',rowId?'?row='+rowId+'&database='+context.databaseId:'/');void show();};
    const rowPages={lookup:async()=>null,copyFromLegacy:async()=>{throw Error('unused');},reconcileLegacy:async()=>{throw Error('unused');},mount:()=>({destroy(){}}),navigate:go,navigation:{current:()=>closingPath?null:route(),back:()=>go(null)}};
    const schema=[{id:'t',name:'Name',type:'title',position:'a0'}];
    const views=[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],visibleProperties:[],openPagesIn:'side'}];
    const db=(id,parent,content)=>({id,type:'database',...(parent?{parent}:{}),content,data:{schema,views,activeViewId:'v'}});
    const row=(id,parent,title,content)=>({id,type:'database-row',parent,content,data:{properties:{t:title},position:'a0',bodyBlocks:true}});
    // Real structure observed on Sprints (refonte): database > sprint row >
    // Tasks database > task row. Five row levels check the same path recursively.
    editor=new Blok({holder:document.querySelector('[data-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:{class:DatabaseTool,config:{rowPages}},'database-row':DatabaseRowTool},data:{blocks:[
      db('sprints',null,['sprint']),row('sprint','sprints','Sprint #1',['tasks']),
      db('tasks','sprint',['task']),row('task','tasks','Task',['subtasks','text']),
      {id:'text',type:'paragraph',parent:'task',data:{text:'Task content'}},
      db('subtasks','task',['subtask']),row('subtask','subtasks','Subtask',['fourths']),
      db('fourths','subtask',['deep4']),row('deep4','fourths','Deep 4',['fifths']),
      db('fifths','deep4',['deep5']),row('deep5','fifths','Deep 5',['deeptext']),
      {id:'deeptext',type:'paragraph',parent:'deep5',data:{text:'Deep content'}}
    ]}});
    window.editor=editor;window.addEventListener('popstate',()=>{void show();});
    document.querySelector('#home').onclick=()=>go(null);
    document.querySelector('#sprint').onclick=()=>go('sprint',{databaseId:'sprints'});
    document.querySelector('#task').onclick=()=>go('task',{databaseId:'tasks'});
    editor.isReady.then(show).then(()=>window.ready=true).catch(error=>window.fixtureError=error.stack||String(error));
  `.replaceAll("'../src/", "'/@fs/"+resolve('..')+'/src/');
  const page = await browser.newPage({viewport:{width:1200,height:900}});
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
  page.setDefaultTimeout(10000);
  const ready = async (): Promise<void> => {
    await expect.poll(async () => {
      const fixture = await page.evaluate(() => ({ready: Reflect.get(window, 'ready') === true, error: Reflect.get(window, 'fixtureError')}));
      if (pageErrors.length > 0) throw new Error(pageErrors.join('\n'));
      if (fixture.error) throw new Error(String(fixture.error));
      return fixture.ready;
    }, {timeout:15000}).toBe(true);
  };
  try {
    await page.route(origin+'/**', route => route.request().resourceType()==='document'
      ? route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><button id="home">Home</button><button id="sprint">Sprint route</button><button id="task">Task route</button><main data-editor></main><script type="module">${script}</script></body></html>`}) : route.continue());
    await page.goto(origin+'/?row=deep5'); // Canonical resolver also omits databaseId.
    await ready();
    const visibleTitle=()=>page.locator('[data-blok-database-drawer-title]:visible').evaluateAll(elements=>elements.map(element=>(element as HTMLTextAreaElement).value));
    await expect.poll(visibleTitle).toEqual(['Deep 5']);
    expect(new URL(page.url()).hash).toBe('');
    expect(await page.title()).toBe('Deep 5');
    await expect.poll(() => page.getByText('Deep content', {exact:true}).isVisible()).toBe(true);
    await page.getByRole('button',{name:'Home',exact:true}).click();
    await expect.poll(visibleTitle).toEqual([]);
    await page.getByRole('button',{name:'Sprint route',exact:true}).click();
    await expect.poll(visibleTitle).toEqual(['Sprint #1']);
    const taskCell=page.getByRole('gridcell',{name:'Task',exact:true});
    await taskCell.hover();
    await page.locator('[data-row-id="task"] [data-blok-database-table-open]').click();
    await expect.poll(()=>page.locator('[data-blok-database-drawer][data-peek-mode="side"]').count()).toBe(1);
    await page.locator('[data-blok-database-drawer][data-peek-mode="side"] [data-blok-database-peek-expand]').click();
    await expect.poll(visibleTitle).toEqual(['Task']);
    expect(new URL(page.url()).searchParams.get('row')).toBe('task');
    expect(new URL(page.url()).hash).toBe('');
    await page.reload();
    await ready();
    await expect.poll(visibleTitle).toEqual(['Task']);
    expect(await page.title()).toBe('Task');
    expect(new URL(page.url()).searchParams.get('row')).toBe('task');
    await expect.poll(() => page.getByText('Task content', {exact:true}).isVisible()).toBe(true);
    await page.goBack();
    await expect.poll(visibleTitle).toEqual(['Sprint #1']);
    await page.goForward();
    await expect.poll(visibleTitle).toEqual(['Task']);
    await page.getByRole('button',{name:'Home',exact:true}).click();
    await expect.poll(visibleTitle).toEqual([]);
    const parentHref = page.url();
    await page.getByRole('gridcell',{name:'Sprint #1',exact:true}).hover();
    await page.locator('[data-row-id="sprint"] [data-blok-database-table-open]').click();
    await expect.poll(visibleTitle).toEqual(['Sprint #1']);
    expect(page.url()).toBe(parentHref);
    await page.getByRole('gridcell',{name:'Task',exact:true}).hover();
    await page.locator('[data-row-id="task"] [data-blok-database-table-open]').click();
    await expect.poll(visibleTitle).toContain('Task');
    expect(page.url()).toBe(parentHref);
    await page.locator('[data-blok-database-drawer][data-peek-mode="side"] [data-blok-database-peek-expand]').last().click();
    await expect.poll(visibleTitle).toEqual(['Task']);
    expect(new URL(page.url()).searchParams.get('row')).toBe('task');
    expect(new URL(page.url()).hash).toBe('');
    await expect.poll(() => page.getByText('Task content', {exact:true}).isVisible()).toBe(true);
  } catch (error) {
    console.error('Nested row fixture diagnostics', JSON.stringify({pageErrors, ...await page.evaluate(() => ({
      href: location.href, title: document.title, ready: Reflect.get(window, 'ready'), error: Reflect.get(window, 'fixtureError'),
      drawers: Array.from(document.querySelectorAll<HTMLElement>('[data-blok-database-drawer]')).map(drawer => ({
        mode: drawer.getAttribute('data-peek-mode'), visible: drawer.getBoundingClientRect().height > 0,
        title: drawer.querySelector<HTMLTextAreaElement>('[data-blok-database-drawer-title]')?.value,
      })),
      text: document.body.innerText.slice(0,2000),
    }))}));
    throw error;
  } finally { await page.close(); }
},45000);

