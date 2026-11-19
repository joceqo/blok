// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, webkit } from 'playwright';

let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
  server = await createServer({ configFile: resolve('vite.config.mjs'), server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await server?.close(); });

it.each(['chromium', 'webkit'] as const)('skips distant rows while retaining wrapped titles, gutters and row opening (%s)', async engine => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  page.setDefaultTimeout(5000);
  try {
    await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body data-blok-theme="dark"><main tabindex="-1" style="height:650px;box-sizing:border-box;overflow:auto;padding:40px 140px"><div data-blok-interface><div data-blok-editor style="--blok-content-max-width:720px"><div data-blok-database-wrapper></div></div></div></main></body></html>' }));
    await page.goto(origin + '/');
    await page.addScriptTag({ type: 'module', content: `
      import '/src/editor.css';
      import '/src/shell.css';
      import '/@fs/${resolve('../src/styles/lazy/database.css')}';
      import { DatabaseTableView } from '/@fs/${resolve('../src/tools/database/database-table-view.ts')}';
      window.opened=[];
      const labels={'tools.database.tableOpen':'Ouvrir','tools.database.tableSelectRow':'Sélectionner la ligne'};
      const schema=[{id:'t',name:'Title',type:'title',position:'a0'},{id:'n',name:'Note',type:'text',position:'a1'}];
      const table=new DatabaseTableView({readOnly:false,i18n:{t:key=>labels[key]??key},schema,titlePropertyId:'t',handlers:{openRow:id=>window.opened.push(id)},
        view:{id:'v',name:'Table',type:'table',position:'a0',sorts:[],filters:[],loadLimit:100,properties:[{id:'t',visible:true,width:240,wrap:true},{id:'n',visible:true,width:700}]},
        rows:Array.from({length:200},(_,i)=>({id:'r'+i,position:'a'+String(i).padStart(3,'0'),properties:{t:i%2?'Long title '.repeat(15):'Row '+i,n:'Details'}}))
      });
      document.querySelector('[data-blok-database-wrapper]').append(table.createView());
      window.ready=true;
    ` });
    await page.waitForFunction(() => Reflect.get(window, 'ready') === true);
    const rows = page.locator('[data-blok-database-table-row]');
    expect(await rows.count()).toBe(100);
    await page.locator('[data-blok-database-table-load-more]').evaluate(button => (button as HTMLButtonElement).click());
    expect(await rows.count()).toBe(200);
    await rows.evaluateAll(elements => Reflect.set(window, 'initialRows', elements));
    // Check the browser's skipped-content state, not elapsed time or a CSS string.
    // Engines without overflow-clip-margin must retain visible row gutters.
    const contained = await page.evaluate(() => CSS.supports('overflow-clip-margin', '100px'));
    if (contained) {
      await expect.poll(() => rows.last().locator('[data-blok-database-cell]').first().evaluate(el => el.checkVisibility({ contentVisibilityAuto: true }))).toBe(false);
    }
    const tall = page.locator('[data-row-id="r1"]');
    await tall.scrollIntoViewIfNeeded();
    await page.locator('[data-blok-database-table-scroller]').evaluate(el => { el.scrollLeft = 0; });
    const height = await tall.evaluate(el => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(70);
    await tall.hover();
    await page.screenshot({ path: `/tmp/blok-row-containment-${engine}.png` });
    const checkbox = tall.locator('[data-blok-database-table-row-checkbox]');
    if (contained) {
      const clip = await tall.evaluate(el => parseFloat(getComputedStyle(el).overflowClipMargin));
      const gutter = await tall.locator('[data-blok-database-table-gutter]').boundingBox();
      expect(clip).toBeGreaterThanOrEqual(gutter?.width ?? Infinity);
    }
    await checkbox.click();
    expect(await checkbox.getAttribute('aria-checked')).toBe('true');
    await checkbox.click();
    await tall.locator('[data-blok-database-table-open]').click();
    expect(await page.evaluate(() => Reflect.get(window, 'opened'))).toEqual(['r1']);
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    await last.hover();
    await last.locator('[data-blok-database-table-open]').click();
    expect(await page.evaluate(() => Reflect.get(window, 'opened'))).toEqual(['r1', 'r199']);
    if (contained) {
      // The fixture's open callback records the action; move focus as the
      // real peek does so the previously focused row may be skipped again.
      await page.locator('main').evaluate(el => {
        el.focus({ preventScroll: true });
        getSelection()?.removeAllRanges();
      });
      await expect.poll(() => tall.locator('[data-blok-database-cell]').first().evaluate(el => el.checkVisibility({ contentVisibilityAuto: true }))).toBe(false);
      expect(await tall.evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(height, 0);
    }
    await tall.scrollIntoViewIfNeeded();
    expect(await tall.evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(height, 0);
    expect(await rows.count()).toBe(200);
    expect(await rows.evaluateAll(elements => elements.every((element, index) => element === Reflect.get(window, 'initialRows')[index]))).toBe(true);
  } finally { await browser.close(); }
}, 45000);
