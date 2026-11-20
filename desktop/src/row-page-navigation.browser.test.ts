// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

it('expands a real row peek, edits its title/body and follows browser Back without losing the row', async () => {
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    const route=()=>{const rowId=new URL(location.href).searchParams.get('row');return rowId ? {rowId,databaseId:'db'} : null;};
    let editor;
    const show=()=>{const row=route();const db=editor.blocks.getById('db');if(row)db.call('openRow',{rowId:row.rowId,mode:'full',explicit:true});else db.call('closeRow');};
    const rows={lookup:async()=>null,copyFromLegacy:async()=>{throw new Error('No copy needed');},reconcileLegacy:async()=>{throw new Error('No copy needed');},mount:()=>({destroy(){}}),
      navigate(rowId){history.pushState(null,'','?row='+encodeURIComponent(rowId));queueMicrotask(show);},
      navigation:{current:route,back(){history.pushState(null,'','/');show();}}
    };
    editor=new Blok({holder:document.querySelector('[data-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:{class:DatabaseTool,config:{rowPages:rows}},'database-row':DatabaseRowTool},data:{blocks:[
      {id:'db',type:'database',data:{schema:[{id:'t',name:'Name',type:'title',position:'a0'}],views:[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],visibleProperties:[],openPagesIn:'side'}],activeViewId:'v'},content:['r1']},
      {id:'r1',type:'database-row',parent:'db',content:['body'],data:{properties:{t:'Sprint 14'},position:'a0',bodyBlocks:true}},
      {id:'body',type:'paragraph',parent:'r1',data:{text:'Row body'}}
    ]}});
    window.editor=editor;
    window.addEventListener('popstate',show);
    editor.isReady.then(()=>{window.ready=true;});
  `.replaceAll("'../src/", "'/@fs/"+resolve('..')+"/src/");
  const css = ['database','loading','keyframes'].map(name=>readFileSync(`../src/styles/${name}.css`,'utf8')).join('\n');
  const page = await browser.newPage({viewport:{width:1200,height:800}});
  page.setDefaultTimeout(15000);
  try {
    await page.route(origin+'/', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto(origin+'/');
    await page.setContent(`<style>${css}</style><style>body{margin:0;font:16px system-ui;}[data-editor]{padding:40px;}[data-blok-database-drawer]{background:white;}[data-blok-top-layer][popover]{margin:0;border:0;padding:0;}</style><main data-editor></main>`);
    await page.addScriptTag({type:'module',content:script});
    await page.waitForFunction(()=>Boolean((window as unknown as {ready?:boolean}).ready));
    await page.locator('[data-row-id="r1"]').hover();
    await page.locator('[data-row-id="r1"] [data-blok-database-table-open]').click();
    const peek = await page.locator('[data-blok-database-drawer][data-peek-mode="side"]').elementHandle();
    await page.locator('[data-blok-database-peek-expand]').click();
    await expect.poll(()=>new URL(page.url()).searchParams.get('row')).toBe('r1');
    const drawer=page.locator('[data-blok-database-drawer][data-peek-mode="full"]');
    await expect.poll(()=>drawer.count()).toBe(1);
    expect(await drawer.evaluate((full, previous) => full === previous, peek)).toBe(true);
    expect(new URL(page.url()).hash).toBe('');
    await drawer.locator('[data-blok-database-drawer-title]').fill('Sprint 14 edited');
    const body=drawer.locator('[data-blok-database-drawer-editor] [contenteditable="true"]').first();
    await body.fill('Edited row body');
    await page.locator('[data-blok-database-drawer-title]').click();
    const saved = await page.evaluate(async()=>{
      const editor=(window as unknown as {editor:{save():Promise<{blocks:Array<{id:string;data:Record<string,unknown>}>}>}}).editor;
      return editor.save();
    });
    expect(saved.blocks.find(block=>block.id==='r1')?.data.properties).toEqual({t:'Sprint 14 edited'});
    expect(saved.blocks.find(block=>block.id==='body')?.data.text).toEqual([{text:'Edited row body'}]);
    await page.goBack();
    await expect.poll(()=>page.locator('[data-blok-database-drawer][data-open]').count()).toBe(0);
    expect(new URL(page.url()).searchParams.has('row')).toBe(false);
    await page.locator('[data-row-id="r1"]').hover();
    await page.locator('[data-row-id="r1"] [data-blok-database-table-open]').click();
    await expect.poll(()=>page.locator('[data-blok-database-drawer-title]').inputValue()).toBe('Sprint 14 edited');
  } finally { await page.close(); }
}, 45000);

it('opens five real lazy row-body editors and returns to the host without losing content', async () => {
  const script = `
    import { Blok } from '../src/blok.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    import { createDesktopRowPages } from '/@fs/${resolve('src/row-pages.ts')}';
    import { openRowLocation } from '/@fs/${resolve('src/row-route.ts')}';
    const docs = {};
    for (let i=0;i<5;i++) docs['doc'+i] = {blocks:[
      {id:'db'+i,type:'database',data:{schema:[{id:'t',name:'Name',type:'title',position:'a0'}],views:[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],visibleProperties:[]}],activeViewId:'v'},content:['row'+i]},
      {id:'row'+i,type:'database-row',parent:'db'+i,data:{properties:{t:'Sprint '+(i+1)},position:'a0',pageId:'doc'+(i+1)}}
    ]};
    docs.doc5 = {blocks:[{id:'last',type:'paragraph',data:{text:'Deepest content'}}]};
    const diagnostics={created:[],errors:[],opened:[]};
    const rows = createDesktopRowPages({retainEditors:5,lookup:async()=>null,copyFromLegacy:async()=>{throw new Error('unexpected copy')},reconcileLegacy:async()=>{},readOnly:()=>false,
      editorConfig:id=>{diagnostics.created.push(id);return {dataModel:'hierarchical',tools:toolsFor(id),data:docs[id]};},createEditor:config=>new Blok(config),onError:(error,id)=>diagnostics.errors.push({id,error:String(error)})});
    const toolsFor = id => ({paragraph:Paragraph,database:{class:DatabaseTool,config:{rowPages:{...rows,
      navigate(){throw new Error('Host route must not navigate again');},
      navigation:{current:()=>({rowId:'row'+id.slice(3),databaseId:'db'+id.slice(3)}),back(){}}
    }}},'database-row':DatabaseRowTool});
    const editor = new Blok({holder:document.querySelector('[data-editor]'),dataModel:'hierarchical',tools:toolsFor('doc0'),data:docs.doc0});
    window.run = async () => {
      await editor.isReady;
      const path=Array.from({length:5},(_,i)=>({documentId:'doc'+i,rowId:'row'+i,databaseId:'db'+i}));
      try {window.opened = await openRowLocation('doc0',editor.blocks,path,id=>rows.mountedEditor(id),new AbortController().signal,steps=>diagnostics.opened=steps.map(step=>step.row.id));} catch(error) {throw new Error(String(error)+' '+JSON.stringify(diagnostics));}
      return window.opened.map(step=>step.row.id);
    };
    window.closeRows = () => { for(const step of [...window.opened].reverse())step.database.call('closeRow'); };
  `.replaceAll("'../src/", "'/@fs/"+resolve('..')+"/src/");
  const css = ['database','loading','keyframes'].map(name=>readFileSync(`../src/styles/${name}.css`,'utf8')).join('\n');
  const page = await browser.newPage({viewport:{width:1200,height:800}});
  page.setDefaultTimeout(15000);
  try {
    await page.route(origin+'/', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto(origin+'/');
    await page.setContent(`<style>${css}</style><main data-editor></main>`);
    await page.addScriptTag({type:'module',content:script});
    await page.waitForFunction(()=>typeof (window as unknown as {run?:unknown}).run === 'function');
    const run = () => page.evaluate(()=>(window as unknown as {run():Promise<string[]>}).run());
    expect(await run()).toEqual(['row0','row1','row2','row3','row4']);
    await page.getByText('Deepest content',{exact:true}).waitFor({state:'visible'});
    expect(new URL(page.url()).hash).toBe('');
    await page.evaluate(()=>(window as unknown as {closeRows():void}).closeRows());
    await page.locator('[data-row-id="row0"]').waitFor({state:'visible'});
    expect(await run()).toEqual(['row0','row1','row2','row3','row4']);
    await page.getByText('Deepest content',{exact:true}).waitFor({state:'visible'});
    expect(new URL(page.url()).hash).toBe('');
  } finally { await page.close(); }
}, 60000);
