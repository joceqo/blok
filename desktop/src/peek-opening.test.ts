// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { chromium, type Browser } from 'playwright';

interface Drawer {
  open(row: unknown, mode: string): void;
  setRowPageLookup(rowId: string, state: string): void;
  destroy(): void;
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
    expect(await page.locator('[data-blok-database-drawer]').evaluate(el => el.matches(':popover-open'))).toBe(true);
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
