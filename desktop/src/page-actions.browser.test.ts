// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

let browser: Browser;
beforeAll(async () => { browser=await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel:'chrome'} : {}); });
afterAll(async () => { await browser?.close(); });
const script=buildSync({entryPoints:['src/page-toolbar.ts'],bundle:true,write:false,format:'iife',globalName:'Toolbar',loader:{'.svg':'text'},logLevel:'silent'}).outputFiles[0].text;
const reset=readFileSync('../src/styles/main.css','utf8').match(/\[data-blok-top-layer\]\[popover\] \{[^}]+\}/)?.[0];
if (!reset) throw new Error('Missing actual top-layer reset');
const css=reset+'\n'+readFileSync('src/shell.css','utf8');
async function fixture(page:Page):Promise<void>{
  await page.setContent(`<style>${css}</style><style>[data-fixture]{transform:translateX(-32px);overflow:hidden;margin:16px 24px 0 80px;}[data-desktop-page-toolbar]{position:relative;}</style><div data-fixture></div>`);
  await page.addScriptTag({content:script});
  await page.evaluate(()=>{
    const api=(window as unknown as {Toolbar:{createPageToolbar: (...args:unknown[])=>{element:HTMLElement}}}).Toolbar;
    const toolbar=api.createPageToolbar([{id:'sprints',title:'Sprints'}],false,()=>{},undefined,undefined,{onRename:()=>{},onDuplicate:()=>{},onMove:()=>{},onHistory:()=>{},onDelete:()=>{}});
    document.querySelector('[data-fixture]')?.append(toolbar.element);
  });
  await page.getByRole('button',{name:'Actions de la page',exact:true}).click();
}
it('aligns the promoted menu with its trigger using the actual width, and follows a viewport resize',async()=>{
  const page=await browser.newPage({viewport:{width:1200,height:760}});
  try{
    await fixture(page);
    const menu=page.getByRole('dialog',{name:'Actions de la page'});
    const trigger=page.getByRole('button',{name:'Actions de la page',exact:true});
    const right=async()=>{
      const [m,b]=await Promise.all([menu.boundingBox(),trigger.boundingBox()]);
      if(!m||!b)throw new Error('Missing menu bounds');
      return m.x+m.width-(b.x+b.width);
    };
    await expect.poll(right).toBeCloseTo(0,0);
    const initial=await menu.boundingBox();
    expect(initial?.width).toBe(280);
    if (process.env.BLOK_MENU_SCREENSHOTS) {
      const triggerBox=await trigger.boundingBox();
      if (!initial || !triggerBox) throw new Error('Missing screenshot bounds');
      const clip={x:initial.x-12,y:Math.max(0,triggerBox.y-12),width:initial.width+24,height:initial.y+initial.height-triggerBox.y+24};
      await page.screenshot({path:'/tmp/blok-page-actions-dark.png',clip});
      await page.locator('[data-fixture]').evaluate(el=>{
        el.setAttribute('data-desktop-shell','');el.setAttribute('data-blok-theme','light');
      });
      await page.screenshot({path:'/tmp/blok-page-actions-light.png',clip});
      await page.locator('[data-fixture]').evaluate(el=>{el.removeAttribute('data-desktop-shell');el.removeAttribute('data-blok-theme');});
    }
    await page.setViewportSize({width:820,height:540});
    await expect.poll(right).toBeCloseTo(0,0);
    await page.keyboard.press('Escape');
    expect(await trigger.evaluate(el=>el===document.activeElement)).toBe(true);
  }finally{await page.close();}
});
it('keeps search and actions reachable inside a narrow, short viewport',async()=>{
  const page=await browser.newPage({viewport:{width:360,height:320}});
  try{
    await fixture(page);
    const menu=page.getByRole('dialog',{name:'Actions de la page'});
    const search=menu.getByRole('searchbox',{name:'Rechercher une action'});
    await search.fill('dupl');
    expect(await menu.getByRole('button',{name:'Dupliquer',exact:true}).isVisible()).toBe(true);
    expect(await menu.getByRole('button',{name:'Renommer',exact:true}).isVisible()).toBe(false);
    await search.fill('');
    const box=await menu.boundingBox();
    if(!box)throw new Error('Missing menu');
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x+box.width).toBeLessThanOrEqual(352);
    expect(box.y+box.height).toBeLessThanOrEqual(312);
    await menu.getByRole('button',{name:'Mettre à la corbeille',exact:true}).scrollIntoViewIfNeeded();
    expect(await menu.getByRole('button',{name:'Mettre à la corbeille',exact:true}).isVisible()).toBe(true);
  }finally{await page.close();}
});

it('flips above a low trigger and stays aligned while the document scrolls',async()=>{
  const page=await browser.newPage({viewport:{width:1000,height:760}});
  try{
    await fixture(page);
    await page.getByRole('button',{name:'Actions de la page',exact:true}).click();
    await page.locator('[data-fixture]').evaluate(el=>{(el as HTMLElement).style.marginTop='600px';});
    await page.evaluate(()=>{document.body.style.height='1800px';});
    const trigger=page.getByRole('button',{name:'Actions de la page',exact:true});
    await trigger.click();
    const menu=page.getByRole('dialog',{name:'Actions de la page'});
    const gap=async()=>{
      const [m,b]=await Promise.all([menu.boundingBox(),trigger.boundingBox()]);
      if(!m||!b)throw new Error('Missing bounds');
      return b.y-(m.y+m.height);
    };
    await expect.poll(gap).toBeCloseTo(6,0);
    await page.evaluate(()=>window.scrollTo(0,90));
    await expect.poll(gap).toBeCloseTo(6,0);
  }finally{await page.close();}
});
