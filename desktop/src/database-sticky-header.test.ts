// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
});
afterAll(async () => { await browser?.close(); });

const css = readFileSync('../src/styles/database.css', 'utf8');
const source = readFileSync('../src/tools/database/database-sticky-header.ts', 'utf8')
  .replace('export class DatabaseStickyHeader', 'class DatabaseStickyHeader');
const script = ts.transpileModule(`${source}\nwindow.DatabaseStickyHeader = DatabaseStickyHeader;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it('keeps the real, clickable header visible while the page and table scroll', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  try {
    await page.setContent(`<style>${css}</style><style>
      * { box-sizing: border-box; }
      body { margin: 0; }
      [data-desktop-page-canvas] { width: 1200px; height: 400px; overflow: auto; container-type: inline-size; }
      [data-desktop-page-toolbar] { position: sticky; top: 0; height: 44px; z-index: 10; background: white; }
      [data-blok-database-table] { width: 800px; margin-top: 150px; }
      [data-blok-database-table-scroller] { padding: 0; margin: 0; }
      [data-blok-database-table-grid] { width: 1600px; }
      [data-blok-database-table-column-header] { width: 200px; }
    </style><div data-desktop-page-canvas><div data-desktop-page-toolbar>Page</div>
      <div data-blok-database-table><div data-blok-database-table-scroller>
        <div data-blok-database-table-grid><div data-blok-database-table-header>
          <div data-blok-database-table-column-header data-frozen style="inset-inline-start:0">
            <button data-header-action>Column</button>
          </div><div data-blok-database-table-column-header>Other</div>
        </div><div style="height:1000px"></div></div>
      </div></div></div>`);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('[data-blok-database-table-grid]')!;
      const header = document.querySelector<HTMLElement>('[data-blok-database-table-header]')!;
      const scroller = document.querySelector<HTMLElement>('[data-blok-database-table-scroller]')!;
      (window as unknown as { sticky: { destroy(): void }; DatabaseStickyHeader: new (...args: unknown[]) => { destroy(): void }; clicks: number }).clicks = 0;
      grid.addEventListener('click', () => { (window as unknown as { clicks: number }).clicks++; });
      (window as unknown as { sticky: { destroy(): void }; DatabaseStickyHeader: new (...args: unknown[]) => { destroy(): void } }).sticky =
        new (window as unknown as { DatabaseStickyHeader: new (...args: unknown[]) => { destroy(): void } }).DatabaseStickyHeader(scroller, grid, header, () => 0);
      document.querySelector<HTMLElement>('[data-desktop-page-canvas]')!.scrollTop = 220;
    });
    const header = page.locator('[data-blok-database-table-header]');
    await expect.poll(() => header.evaluate(el => el.matches(':popover-open'))).toBe(true);
    expect((await header.boundingBox())?.y).toBeCloseTo(44, 0);
    await page.locator('[data-blok-database-table-scroller]').evaluate(el => { el.scrollLeft = 300; el.setAttribute('data-scrolled', ''); });
    await expect.poll(() => page.locator('[data-frozen]').evaluate(el => el.getBoundingClientRect().left)).toBeCloseTo(0, 0);
    await page.locator('[data-header-action]').click();
    expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    await page.locator('[data-desktop-page-canvas]').evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => header.evaluate(el => el.matches(':popover-open'))).toBe(false);
    await page.evaluate(() => (window as unknown as { sticky: { destroy(): void } }).sticky.destroy());
  } finally {
    await page.close();
  }
});
