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
        </div><div style="height:1000px;display:flex">
          <div data-blok-database-table-cell data-frozen style="inset-inline-start:0;width:200px;flex:none">Frozen body</div>
          <div data-body-column style="width:200px;flex:none">Other body</div>
        </div></div>
      </div></div></div>`);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('[data-blok-database-table-grid]')!;
      const header = document.querySelector<HTMLElement>('[data-blok-database-table-header]')!;
      const scroller = document.querySelector<HTMLElement>('[data-blok-database-table-scroller]')!;
      (window as unknown as { sticky: { destroy(): void }; DatabaseStickyHeader: new (...args: unknown[]) => { destroy(): void }; clicks: number }).clicks = 0;
      grid.addEventListener('click', () => { (window as unknown as { clicks: number }).clicks++; });
      (window as unknown as { sticky: { destroy(): void }; DatabaseStickyHeader: new (...args: unknown[]) => { destroy(): void } }).sticky =
        new (window as unknown as { DatabaseStickyHeader: new (...args: unknown[]) => { destroy(): void } }).DatabaseStickyHeader(scroller, grid, header);
      document.querySelector<HTMLElement>('[data-desktop-page-canvas]')!.scrollTop = 220;
    });
    const header = page.locator('[data-blok-database-table-header]');
    await expect.poll(() => header.evaluate(el => el.hasAttribute('data-blok-database-header-pinned'))).toBe(true);
    expect((await header.boundingBox())?.y).toBeCloseTo(44, 0);
    expect(await header.evaluate(el => getComputedStyle(el).overflowY)).toBe('visible');
    expect(await header.evaluate(el => el.clientHeight)).toBe(36);
    // No event or animation frame is allowed between changing scrollLeft and
    // checking alignment: the browser must move header and body together.
    const offsets = await page.evaluate(() => {
      const port = document.querySelector<HTMLElement>('[data-blok-database-table-scroller]')!;
      const head = document.querySelector<HTMLElement>('[data-blok-database-table-header]')!;
      const body = document.querySelector<HTMLElement>('[data-body-column]')!;

      return [80, 340, 120, 0].map(x => {
        port.scrollLeft = x;
        return head.children[1].getBoundingClientRect().left - body.getBoundingClientRect().left;
      });
    });
    expect(offsets).toEqual([0, 0, 0, 0]);
    await page.locator('[data-blok-database-table-scroller]').evaluate(el => { el.scrollLeft = 300; el.setAttribute('data-scrolled', ''); });
    await expect.poll(() => page.locator('[data-blok-database-table-column-header][data-frozen]').evaluate(el => el.getBoundingClientRect().left)).toBeCloseTo(0, 0);
    await page.locator('[data-header-action]').click();
    expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    await page.locator('[data-desktop-page-canvas]').evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => header.evaluate(el => el.hasAttribute('data-blok-database-header-pinned'))).toBe(false);
    await page.evaluate(() => (window as unknown as { sticky: { destroy(): void } }).sticky.destroy());
  } finally {
    await page.close();
  }
});

it.each(['ltr', 'rtl'])('keeps padded frozen header columns aligned across pinning and horizontal scrolling (%s)', async (direction) => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  try {
    await page.setContent(`<style>${css}</style><style>
      * { box-sizing: border-box; }
      body { margin: 0; --blok-space-2: 8px; --blok-space-2-5: 10px; --blok-space-3: 12px; --blok-content-max-width: 800px; }
      [data-desktop-page-canvas] { width: 1200px; height: 400px; overflow: auto; container-type: inline-size; }
      [data-desktop-page-toolbar] { position: sticky; top: 0; height: 44px; z-index: 10; background: white; }
      [data-blok-database-table] { margin-top: 150px; }
      [data-blok-database-table-grid] { width: 1800px; }
      [data-blok-database-table-column-header], [data-blok-database-table-cell] { width: 200px; }
      [data-frozen] { inset-inline-start: var(--_blok-database-frozen-shift, 0px); }
    </style><div data-desktop-page-canvas data-blok-interface><div data-desktop-page-toolbar>Page</div>
      <div data-blok-database-table><div data-blok-database-table-scroller>
        <div data-blok-database-table-grid><div data-blok-database-table-header>
          <div data-blok-database-table-gutter>Gutter</div>
          <div data-blok-database-table-column-header data-frozen data-frozen-edge>Frozen</div>
          <div data-blok-database-table-column-header>Other</div>
        </div><div data-blok-database-table-row>
          <div data-blok-database-table-gutter>Gutter</div>
          <div data-blok-database-table-cell data-frozen data-frozen-edge>Frozen body</div>
          <div data-blok-database-table-cell>Other body</div>
        </div><div style="height:1000px"></div></div>
      </div></div></div>`);
    await page.locator('html').evaluate((el, dir) => { el.setAttribute('dir', dir); }, direction);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('[data-blok-database-table-grid]');
      const header = document.querySelector<HTMLElement>('[data-blok-database-table-header]');
      const scroller = document.querySelector<HTMLElement>('[data-blok-database-table-scroller]');
      if (grid === null || header === null || scroller === null) throw new Error('Missing table fixture');
      const stickAt = Math.max(0, parseFloat(getComputedStyle(scroller).paddingInlineStart) - 30);
      scroller.style.setProperty('--_blok-database-frozen-shift', `${-stickAt}px`);
      scroller.addEventListener('scroll', () => {
        scroller.toggleAttribute('data-scrolled', Math.abs(scroller.scrollLeft) !== 0 && Math.abs(scroller.scrollLeft) >= stickAt);
        scroller.toggleAttribute('data-frozen-shadow', Math.abs(scroller.scrollLeft) >= stickAt + 5);
      });
      new (window as unknown as { DatabaseStickyHeader: new (...args: unknown[]) => unknown }).DatabaseStickyHeader(scroller, grid, header);
    });
    expect(await page.locator('[data-blok-database-table-scroller]').evaluate(el => getComputedStyle(el).paddingInlineStart)).toBe('200px');
    const snapshots = [];
    for (const scrollTop of [0, 220, 300, 0]) {
      await page.locator('[data-desktop-page-canvas]').evaluate((el, y) => { el.scrollTop = y; }, scrollTop);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      for (const scrollLeft of [0, 80, 169, 170, 171, 340, 120, 0]) {
        await page.locator('[data-blok-database-table-scroller]').evaluate((el, x) => { el.scrollLeft = x; }, direction === 'rtl' ? -scrollLeft : scrollLeft);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        snapshots.push(await page.evaluate(() => {
          const head = document.querySelector<HTMLElement>('[data-blok-database-table-column-header][data-frozen]');
          const body = document.querySelector<HTMLElement>('[data-blok-database-table-cell][data-frozen]');
          const movingHead = document.querySelector<HTMLElement>('[data-blok-database-table-column-header]:not([data-frozen])');
          const movingBody = document.querySelector<HTMLElement>('[data-blok-database-table-cell]:not([data-frozen])');
          if (head === null || body === null || movingHead === null || movingBody === null) throw new Error('Missing frozen cells');
          const rect = head.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + 100, rect.top + 18);
          return { head: rect.left, body: body.getBoundingClientRect().left, movingOffset: movingHead.getBoundingClientRect().left - movingBody.getBoundingClientRect().left, top: rect.top, clickable: hit?.closest('[data-blok-database-table-column-header]') === head };
        }));
      }
    }
    expect(snapshots.map(({ head, body }) => head - body)).toEqual(Array(32).fill(0));
    expect(snapshots.map(({ movingOffset }) => movingOffset)).toEqual(Array(32).fill(0));
    expect(snapshots.map(({ top }) => top)).toEqual([194, 44, 44, 194].flatMap(top => Array(8).fill(top)));
    expect(snapshots.every(({ clickable }) => clickable)).toBe(true);

    await page.locator('[data-desktop-page-canvas]').evaluate(el => { el.scrollTop = 220; });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.evaluate(() => {
      const port = document.querySelector<HTMLElement>('[data-blok-database-table-scroller]');
      const head = document.querySelector<HTMLElement>('[data-blok-database-table-column-header]:not([data-frozen])');
      const body = document.querySelector<HTMLElement>('[data-blok-database-table-cell]:not([data-frozen])');
      if (port === null || head === null || body === null) throw new Error('Missing wheel fixture');
      const state = { stop: false, samples: [] as { scroll: number; offset: number; top: number }[] };
      (window as unknown as { wheelProbe: typeof state }).wheelProbe = state;
      const sample = (): void => {
        if (state.stop) return;
        state.samples.push({ scroll: port.scrollLeft, offset: head.getBoundingClientRect().left - body.getBoundingClientRect().left, top: head.getBoundingClientRect().top });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.mouse.move(600, 150);
    for (const delta of [160, 160, 160, -160, -160, -160]) {
      await page.mouse.wheel(direction === 'rtl' ? -delta : delta, 0);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    const wheelSamples = await page.evaluate(() => {
      const probe = (window as unknown as { wheelProbe: { stop: boolean; samples: { scroll: number; offset: number; top: number }[] } }).wheelProbe;
      probe.stop = true;
      return probe.samples;
    });
    expect(wheelSamples.some(({ scroll }) => Math.abs(scroll) > 0)).toBe(true);
    expect(wheelSamples.every(({ offset, top }) => offset === 0 && top === 44)).toBe(true);

  } finally {
    await page.close();
  }
});
