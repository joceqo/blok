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
  browser=await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel:'chrome'} : {});
});
afterAll(async () => { await browser?.close(); await server?.close(); });

it('renders remote page content before scrolling while only closed row bodies stay deferred', async () => {
  const script=`
    import { Core } from '../src/components/core.ts';
    import { DocumentStore } from '../src/components/modules/yjs/document-store.ts';
    import { YBlockSerializer } from '../src/components/modules/yjs/serializer.ts';
    import { Paragraph } from '../src/tools/paragraph/index.ts';
    import { Table } from '../src/tools/table/index.ts';
    import { DatabaseTool } from '../src/tools/database/index.ts';
    import { DatabaseRowTool } from '../src/tools/database-row/index.ts';
    const paragraphs=Array.from({length:160},(_,i)=>({id:'text-'+i,type:'paragraph',data:{text:'Visible content '+i}}));
    const blocks=[...paragraphs.slice(0,80),
      {id:'db',type:'database',data:{schema:[{id:'title',name:'Name',type:'title',position:'a0'}],views:[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],visibleProperties:[]}],activeViewId:'v'},content:['r1','r2']},
      ...['r1','r2'].flatMap((id,i)=>[
        {id,type:'database-row',parent:'db',content:['table-'+i,'parent-'+i],data:{properties:{title:id},position:'a'+i,bodyBlocks:true}},
        {id:'table-'+i,type:'table',parent:id,data:{content:[['Hidden body '+i,'Value'],['Commit','abc123']],withHeadings:true}},
        {id:'parent-'+i,type:'paragraph',parent:id,content:['child-'+i],data:{text:'Parent body '+i}},
        {id:'child-'+i,type:'paragraph',parent:'parent-'+i,data:{text:'Nested body '+i}}
      ]),...paragraphs.slice(80)];
    const store=new DocumentStore(new YBlockSerializer());store.fromJSON(blocks);
    const core=new Core({holder:document.querySelector('[data-editor]'),tools:{paragraph:Paragraph,table:Table,database:DatabaseTool,'database-row':DatabaseRowTool}});
    window.core=core;
    core.isReady.then(async()=>{
      await core.moduleInstances.BlockManager.clear(false);
      core.moduleInstances.YjsManager.applyRemoteUpdate(store.encodeStateAsUpdate());
      window.applied=true;
    });
    window.loaded=()=>window.applied && !core.moduleInstances.BlockManager.isSyncingFromYjs;
    window.renderState=()=>({
      ordinary:core.moduleInstances.BlockManager.blocks.filter(block=>block.id.startsWith('text-')).map(block=>({id:block.id,text:block.holder.textContent,deferred:block.holder.hasAttribute('data-blok-deferred-render')})),
      sleepingTables:['table-0','table-1'].map(id=>core.moduleInstances.BlockManager.getBlockById(id)?.holder.hasAttribute('data-blok-deferred-render'))
    });
    window.openBody=()=>core.moduleInstances.BlockManager.getBlockById('db').call('openRow',{rowId:'r1'});
  `.replaceAll("'../src/", "'/@fs/"+resolve('..')+"/src/");
  const css=['database','loading','keyframes'].map(name=>readFileSync(`../src/styles/${name}.css`,'utf8')).join('\n');
  const page=await browser.newPage({viewport:{width:1100,height:700}});
  page.setDefaultTimeout(15000);
  try {
    await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto(origin+'/');
    await page.setContent(`<style>${css}</style><style>[data-scroll-canvas]{height:240px;overflow:auto} [data-editor]{font:16px/24px system-ui} [data-blok-component="paragraph"]{min-height:24px} .hidden{display:none!important}</style><main data-scroll-canvas><div data-editor></div></main>`);
    await page.addScriptTag({type:'module',content:script});
    await page.waitForFunction(()=>Boolean((window as unknown as {loaded?:()=>boolean}).loaded?.()));
    const state=await page.evaluate(()=>(window as unknown as {renderState():{ordinary:Array<{id:string;text:string;deferred:boolean}>;sleepingTables:boolean[]}}).renderState());
    expect(state.ordinary.filter(block=>block.deferred)).toEqual([]);
    expect(state.ordinary).toHaveLength(160);
    expect(state.ordinary.every((block,i)=>block.text.includes(`Visible content ${i}`))).toBe(true);
    expect(await page.locator('[data-blok-offscreen]').count()).toBe(0);
    expect(state.sleepingTables).toEqual([true,true]);
    await page.locator('[data-scroll-canvas]').evaluate(element=>{const scrollport=element;scrollport.scrollTop=scrollport.scrollHeight;});
    await page.getByText('Visible content 159',{exact:true}).scrollIntoViewIfNeeded();
    await page.getByText('Visible content 159',{exact:true}).waitFor({state:'visible'});
    const bottom=await page.getByText('Visible content 159',{exact:true}).boundingBox();
    const canvas=await page.locator('[data-scroll-canvas]').boundingBox();
    if (!bottom || !canvas) throw new Error('Missing rendered content');
    expect(bottom.y).toBeGreaterThanOrEqual(canvas.y);
    expect(bottom.y).toBeLessThan(canvas.y+canvas.height);
    await page.evaluate(()=>(window as unknown as {openBody():void}).openBody());
    await page.getByText('Hidden body 0',{exact:true}).waitFor({state:'visible'});
    await page.getByText('Nested body 0',{exact:true}).waitFor({state:'visible'});
    expect(await page.locator('[data-blok-id="child-0"]').evaluate(child=>child.parentElement === document.querySelector('[data-blok-id="parent-0"]')?.parentElement)).toBe(true);
    expect(await page.getByText('Nested body 1',{exact:true}).count()).toBe(0);
    expect(await page.getByText('Hidden body 1',{exact:true}).count()).toBe(0);
  } finally { await page.close(); }
},45000);
