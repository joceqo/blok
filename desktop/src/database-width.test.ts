// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
});
afterAll(async () => { await browser?.close(); });

const shell = readFileSync('src/shell.css', 'utf8');
const databaseStyles = readFileSync('../src/styles/database.css', 'utf8');

it('lets a root database fill the page canvas while its table scrolls locally', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  try {
    await page.setContent(`<style>${shell}</style><style>${databaseStyles}</style><style>
      [data-desktop-page-canvas] { width: 100%; overflow-x: auto; --max-width-content: 720px; }
      [data-blok-interface] { --blok-editor-gutter-start: 56px; }
      [data-blok-redactor] { padding-inline-start: 56px; }
      [data-blok-element-content] { max-width: 720px; margin-inline: auto; }
      [data-blok-width="full"] [data-blok-element-content] { max-width: none; }
      [data-blok-database-table-grid] { width: 2000px; height: 80px; }
    </style><div data-desktop-page-canvas><article data-desktop-document>
      <div data-desktop-editor><div data-blok-interface><div data-blok-redactor>
        <div data-blok-element><div data-blok-element-content data-text-column>Text</div></div>
        <div data-blok-element><div data-blok-element-content data-database-content>
          <div data-blok-database-wrapper><div data-blok-database-board-container>
            <div data-blok-database-table><div data-blok-database-table-scroller>
              <div data-blok-database-table-grid>Table</div>
            </div></div>
          </div></div>
        </div></div>
      </div></div></div>
    </article></div>`);

    const canvas = page.locator('[data-desktop-page-canvas]');
    const text = await page.locator('[data-text-column]').boundingBox();
    const database = await page.locator('[data-database-content]').boundingBox();
    const scroller = page.locator('[data-blok-database-table-scroller]');
    const scrollBox = await scroller.boundingBox();

    expect(database?.x).toBeCloseTo(text!.x, 0);
    expect(database?.width).toBeCloseTo(text!.width, 0);
    expect(scrollBox?.x).toBeCloseTo(0, 0);
    expect(scrollBox?.width).toBeCloseTo(1440, 0);
    expect((await page.locator('[data-blok-database-table-grid]').boundingBox())?.x).toBeCloseTo(text!.x, 0);
    expect(await canvas.evaluate(el => el.scrollWidth)).toBe(1440);
    await scroller.evaluate(el => { el.scrollLeft = 400; });
    expect(await scroller.evaluate(el => el.scrollLeft)).toBe(400);
    expect(await canvas.evaluate(el => el.scrollLeft)).toBe(0);

    await page.locator('[data-desktop-document]').evaluate(el => el.setAttribute('data-full-width', ''));
    await page.locator('[data-blok-interface]').evaluate(el => el.setAttribute('data-blok-width', 'full'));
    const fullWidthDatabase = await page.locator('[data-database-content]').boundingBox();
    expect(fullWidthDatabase?.x).toBeCloseTo(128, 0);
    expect(fullWidthDatabase?.width).toBeCloseTo(1240, 0);
    expect((await scroller.boundingBox())?.x).toBeCloseTo(0, 0);

    await page.locator('[data-desktop-document]').evaluate(el => el.removeAttribute('data-full-width'));
    await page.locator('[data-blok-interface]').evaluate(el => el.removeAttribute('data-blok-width'));
    await page.setViewportSize({ width: 800, height: 800 });
    const narrowDatabase = await page.locator('[data-database-content]').boundingBox();
    expect(narrowDatabase?.x).toBeCloseTo(120, 0);
    expect(narrowDatabase?.width).toBeCloseTo(616, 0);
    expect((await scroller.boundingBox())?.width).toBeCloseTo(800, 0);
    expect(await canvas.evaluate(el => el.scrollWidth)).toBe(800);
    expect(await canvas.evaluate(el => el.scrollLeft)).toBe(0);
  } finally {
    await page.close();
  }
});
