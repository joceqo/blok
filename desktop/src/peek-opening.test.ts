// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { chromium, type Browser } from 'playwright';

interface Drawer {
  open(row: unknown, mode: string): void;
  setRowPageLookup(rowId: string, state: string): void;
  destroy(): void;
  close(): void;
  readonly isOpen: boolean;
}
interface Harness {
  Peek: { DatabaseCardDrawer: new (options: unknown) => Drawer };
  drawer: Drawer;
  events: string[];
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
});

it.each(['side', 'center'])('keeps a %s peek above transformed hosts, below its menus, and closes only on completed backdrop clicks', async mode => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.route('http://peek.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('http://peek.test/');
    await page.setContent(`<style>${css}</style><style>
      body { margin:0; font:16px system-ui; }
      [data-blok-top-layer][popover] { margin:0; border:0; padding:0; }
      [data-blok-database-drawer] { background:white; --blok-space-4:16px; --blok-z-drawer:100; }
      [data-blok-editor] { color:rgb(40,50,60); transform:translate(80px,50px); overflow:hidden; width:200px; height:100px; }
      [data-old-menu] { position:fixed; inset:0 auto auto 0; width:100px; height:100px; }
    </style><div data-blok-editor><div data-parent></div><div data-child></div></div><button data-old-menu popover="manual">Old menu</button>`);
    await page.addScriptTag({ content: script });
    await page.evaluate(mode => {
      const host = window as unknown as Harness & { parentDrawer: Drawer; menuClicks: number; oldClicks: number };
      const create = (selector: string): Drawer => new host.Peek.DatabaseCardDrawer({
        wrapper: document.querySelector(selector), readOnly: false, titlePropertyId: 'title', schema: [],
        onTitleChange: () => {}, onDescriptionChange: () => {}, onClose: () => {},
        rowBody: { attach: (_id: string, holder: HTMLElement) => { holder.textContent = 'Body'; return true; }, detach: () => {} },
      });
      const old = document.querySelector<HTMLButtonElement>('[data-old-menu]')!;
      host.oldClicks = 0; old.onclick = () => host.oldClicks++; old.showPopover();
      host.parentDrawer = create('[data-parent]');
      host.parentDrawer.open({ id: 'parent', position: 'a0', properties: { title: 'Parent' } }, 'full');
      host.drawer = create('[data-child]');
      host.drawer.open({ id: 'child', position: 'a0', properties: { title: 'Child' } }, mode);
    }, mode);
    await expect.poll(() => page.locator('[data-blok-database-drawer][data-open]').count()).toBe(2);
    await page.waitForTimeout(250); // complete the actual side transition before hit-testing
    const rect = await page.locator(`[data-blok-database-drawer][data-peek-mode="${mode}"]`).boundingBox();
    expect(rect!.x + rect!.width).toBeGreaterThan(1000);
    expect(await page.locator(`[data-blok-database-drawer][data-peek-mode="${mode}"]`).evaluate(el => getComputedStyle(el).color)).toBe('rgb(40, 50, 60)');
    expect(await page.evaluate(() => document.elementFromPoint(20, 20)?.hasAttribute('data-blok-database-peek-backdrop'))).toBe(true);
    // A menu created later must remain clickable, including when mounted in the promoted shell.
    await page.evaluate(() => {
      const host = window as unknown as Harness & { menuClicks: number };
      host.menuClicks = 0;
      const menu = document.createElement('button');
      menu.setAttribute('data-blok-popover', ''); menu.setAttribute('popover', 'manual');
      menu.style.cssText = 'position:fixed;left:10px;top:10px;right:auto;bottom:auto;margin:0;width:80px;height:40px';
      menu.textContent = 'Menu'; menu.onclick = () => host.menuClicks++;
      document.querySelector('[data-blok-database-peek-backdrop]')!.append(menu);
      menu.showPopover();
    });
    await page.locator('button[data-blok-popover]').click();
    expect(await page.evaluate(() => (window as unknown as Harness & { menuClicks: number }).menuClicks)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as Harness).drawer.isOpen)).toBe(true);
    await page.evaluate(() => document.querySelector('button[data-blok-popover]')!.remove());
    // Clicking the title/panel must not bubble into a backdrop dismissal.
    await page.locator(`[data-peek-mode="${mode}"] [data-blok-database-drawer-title]`).click();
    expect(await page.evaluate(() => (window as unknown as Harness).drawer.isOpen)).toBe(true);
    await page.mouse.move(20, 20); await page.mouse.down();
    expect(await page.evaluate(() => (window as unknown as Harness).drawer.isOpen)).toBe(true);
    await page.mouse.up();
    expect(await page.evaluate(() => (window as unknown as Harness).drawer.isOpen)).toBe(false);
    expect(await page.evaluate(() => (window as unknown as Harness & { parentDrawer: Drawer }).parentDrawer.isOpen)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as Harness & { oldClicks: number }).oldClicks)).toBe(0);
    await expect.poll(() => page.locator('[data-blok-database-peek-exiting]').count()).toBe(0);
    await page.evaluate(() => {
      const host = window as unknown as Harness & { parentDrawer: Drawer };
      host.drawer.destroy(); host.parentDrawer.destroy();
    });
  } finally { await page.close(); }
});
afterAll(async () => { await browser?.close(); });
const script = buildSync({ entryPoints: ['../src/tools/database/database-card-drawer.ts'], bundle: true, write: false,
  format: 'iife', globalName: 'Peek', loader: { '.svg': 'text', '.css': 'text' }, define: { VERSION: '"test"' }, logLevel: 'silent',
}).outputFiles[0].text;
const css = ['database', 'loading', 'keyframes'].map(name => readFileSync(`../src/styles/${name}.css`, 'utf8')).join('\n');

it.each([false, true])('uses native popovers, defers inline mounting and respects intervening focus: %s', async chooseControl => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.setContent(`<style>${css}</style><style>
      body { margin:0; font:16px system-ui; }
      [data-blok-top-layer][popover] { margin:0; border:0; padding:0; }
      [data-blok-database-drawer] { background:white; --blok-space-1:4px; --blok-space-2:8px; --blok-space-4:16px; }
    </style><div data-blok-editor><button data-open-row>Open</button><div data-database></div></div>`);
    await page.addScriptTag({ content: script });
    const immediate = await page.evaluate(choose => {
      const host = window as unknown as Harness;
      const wrapper = document.querySelector<HTMLElement>('[data-database]');
      if (wrapper === null) throw new Error('No wrapper');
      host.events = [];
      document.querySelector<HTMLButtonElement>('[data-open-row]')?.focus();
      // Register before open(), like the profile's paint-opportunity probe.
      requestAnimationFrame(() => setTimeout(() => host.events.push('shell-opportunity'), 0));
      host.drawer = new host.Peek.DatabaseCardDrawer({
        wrapper, readOnly: false, titlePropertyId: 'title', schema: [],
        onTitleChange: () => {}, onDescriptionChange: () => {}, onClose: () => {},
        rowBody: { attach: (_id: string, holder: HTMLElement) => { host.events.push('inline-body'); holder.textContent = 'Loaded body'; return true; }, detach: () => {} },
        rowPages: { lookup: async () => null },
      });
      host.drawer.setRowPageLookup('row', 'pending');
      host.drawer.open({ id: 'row', position: 'a0', bodyBlocks: true, properties: { title: 'Sprint' } }, 'side');
      const title = wrapper.querySelector<HTMLTextAreaElement>('[data-blok-database-drawer-title]');
      const focused = document.activeElement === title;
      if (choose) wrapper.querySelector<HTMLButtonElement>('[data-blok-database-peek-expand]')?.focus();
      queueMicrotask(() => host.drawer.setRowPageLookup('row', 'done'));
      return { focused, mounted: host.events.includes('inline-body') };
    }, chooseControl);
    expect(immediate).toEqual({ focused: false, mounted: false });
    await expect.poll(() => page.evaluate(() => (window as unknown as Harness).events)).toEqual(['shell-opportunity', 'inline-body']);
    const expectedFocus = chooseControl ? '[data-blok-database-peek-expand]' : '[data-blok-database-drawer-title]';
    await expect.poll(() => page.evaluate(selector => document.activeElement?.matches(selector), expectedFocus)).toBe(true);
    expect(await page.locator(':popover-open').count()).toBe(1);
    expect(await page.locator('[data-blok-database-drawer]').evaluate(el => el.parentElement?.matches(':popover-open'))).toBe(true);
    expect(await page.locator('[data-blok-database-peek-backdrop]').evaluate(el => el.matches(':popover-open'))).toBe(true);
    if (!chooseControl) {
      await page.keyboard.press('End');
      await page.keyboard.type(' 14');
      expect(await page.locator('[data-blok-database-drawer-title]').inputValue()).toBe('Sprint 14');
    }
    await page.mouse.click(20, 400);
    await expect.poll(() => page.locator('[data-blok-database-peek-backdrop]').count()).toBe(0);
    await page.evaluate(() => (window as unknown as Harness).drawer.destroy());
  } finally {
    await page.close();
  }
});
