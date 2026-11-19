// @vitest-environment node
import {afterAll,beforeAll,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer,type ViteDevServer} from 'vite';
import {chromium,type Browser} from 'playwright';

let server:ViteDevServer;
let browser:Browser;
let origin:string;
beforeAll(async()=>{
  server=await createServer({configFile:resolve('vite.config.mjs'),server:{port:0,host:'127.0.0.1',hmr:false},logLevel:'error'});
  await server.listen(); const address=server.httpServer?.address();
  if(!address || typeof address==='string')throw new Error('Missing test server');
  origin=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?{channel:'chrome'}:{});
});
afterAll(async()=>{await browser?.close();await server?.close();});

it.each(['typing','paste','close'] as const)('keeps real editor first content until acknowledged (%s)',async scenario=>{
  const page=await browser.newPage({viewport:{width:1200,height:800}});page.setDefaultTimeout(12000);
  try {
    await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body data-blok-theme="dark"><main data-editor></main></body></html>'}));
    await page.goto(origin+'/');
    await page.addScriptTag({type:'module',content:`
      import '/src/editor.css'; import '/src/shell.css';
      import {Blok} from '/@fs/${resolve('../src/blok.ts')}';
      import {Paragraph} from '/@fs/${resolve('../src/tools/paragraph/index.ts')}';
      import {DatabaseTool} from '/@fs/${resolve('../src/tools/database/index.ts')}';
      import {DatabaseRowTool} from '/@fs/${resolve('../src/tools/database-row/index.ts')}';
      import {createRowBodyDrafts} from '/@fs/${resolve('src/row-body-draft.ts')}';
      window.requests=[];window.normalMounts=0;
      let receipt,bodyReady;
      const bodyGate=new Promise(resolve=>bodyReady=resolve);
      const mountPage=(pageId,holder)=>{
        window.normalMounts++;
        const body=new Blok({holder,tools:{paragraph:Paragraph},data:window.requests[0].body});
        return {destroy:()=>body.destroy(),ready:body.isReady.then(()=>bodyGate)};
      };
      const drafts=createRowBodyDrafts({scope:'browser-account:workspace',readOnly:()=>false,
        create:input=>{window.requests.push(structuredClone(input));return new Promise(resolve=>receipt=resolve);},
        createEditor:config=>{const editor=new Blok({...config,tools:{paragraph:Paragraph},tabSync:false});return {isReady:editor.isReady,save:()=>editor.save(),readOnly:editor.readOnly,destroy:()=>editor.destroy()};},
        mountPage,
      });
      const pages={lookup:async()=>null,copyFromLegacy:async()=>{throw Error('legacy');},reconcileLegacy:async()=>{throw Error('legacy');},mount:mountPage,
        mountEmpty:(rowId,holder)=>drafts.mount('physical',rowId,holder),hasDraft:rowId=>drafts.hasDraft('physical',rowId)};
      const editor=new Blok({holder:document.querySelector('[data-editor]'),dataModel:'hierarchical',tools:{paragraph:Paragraph,database:{class:DatabaseTool,config:{rowPages:pages}},'database-row':DatabaseRowTool},data:{blocks:[
        {id:'db',type:'database',content:['r1','r2'],data:{schema:[{id:'t',name:'Name',type:'title',position:'a0'}],views:[{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],properties:[{id:'t',visible:true,width:500}]}],activeViewId:'v'}},
        ...['r1','r2'].map((id,i)=>({id,type:'database-row',parent:'db',data:{properties:{t:'Row '+i},position:'a'+i}}))
      ]}});
      window.open=rowId=>editor.blocks.getById('db').call('openRow',{rowId,mode:'side'});
      window.project=()=>editor.blocks.update('r1',{pageId:'created-body',properties:{t:'Row 0'},position:'a0'});
      window.ack=()=>receipt({pageId:'created-body'});window.release=()=>bodyReady();
      window.source=()=>editor.save();window.flush=()=>drafts.flush();
      editor.isReady.then(()=>window.ready=true);
    `});
    await page.waitForFunction(()=>Reflect.get(window,'ready')===true);
    await page.locator('[data-row-id="r1"]').hover();
    await page.locator('[data-row-id="r1"] [data-blok-database-table-open]').click();
    const title=page.locator('[data-blok-database-drawer-title]');
    const input=page.locator('[data-row-body-draft] [contenteditable="true"]').first();
    await input.waitFor(); await title.press('Enter');
    await expect.poll(()=>input.evaluate(el=>el.contains(document.activeElement))).toBe(true);
    await input.press('Space');
    await page.evaluate(()=>Reflect.get(window,'flush')());
    expect(await page.evaluate(()=>Reflect.get(window,'requests').length)).toBe(0);
    await input.fill(''); await page.evaluate(()=>Reflect.get(window,'flush')());
    if(scenario==='paste') {
      await input.evaluate(el=>{const transfer=new DataTransfer();transfer.setData('text/plain','Pasted first content');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));});
    } else await input.press('a');
    await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'requests').length)).toBe(1);
    const requests=await page.evaluate(()=>Reflect.get(window,'requests'));
    expect(JSON.stringify(requests[0].body)).toContain(scenario==='paste'?'Pasted first content':'a');
    await page.evaluate(()=>Reflect.get(window,'project')());
    expect(await page.locator('[data-row-body-draft]').count()).toBe(1);
    expect(await page.evaluate(()=>Reflect.get(window,'normalMounts'))).toBe(0);
    if(scenario==='close') await page.evaluate(()=>Reflect.get(window,'open')('r2'));
    await page.evaluate(()=>Reflect.get(window,'ack')());
    if(scenario==='close') await page.evaluate(()=>Reflect.get(window,'open')('r1'));
    await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'normalMounts'))).toBe(1);
    expect(await page.evaluate(()=>localStorage.length)).toBeGreaterThan(0);
    await page.evaluate(()=>Reflect.get(window,'release')());
    await expect.poll(()=>page.locator('[data-row-body-draft] [inert]').count()).toBe(0);
    await expect.poll(()=>page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('blok-row-draft:')).length)).toBe(0);
    const source=await page.evaluate(()=>Reflect.get(window,'source')());
    expect(source.blocks.filter((block:{parent?:string})=>block.parent==='r1')).toEqual([]);
    expect(await page.evaluate(()=>Reflect.get(window,'requests').length)).toBe(1);
  } finally {await page.close();}
},45000);
