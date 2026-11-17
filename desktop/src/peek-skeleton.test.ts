// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
});
afterAll(async () => { await browser?.close(); });

const script = buildSync({ entryPoints: ['../src/components/utils/loading-skeleton.ts'], bundle: true, write: false, format: 'iife', globalName: 'Skeleton' }).outputFiles[0].text;
const css = ['loading', 'database', 'keyframes'].map(name => readFileSync(`../src/styles/${name}.css`, 'utf8')).join('\n');

it.each(['light', 'dark'])('keeps %s peek skeletons aligned across the editor handoff and conceals stale values', async (theme) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 660 }, reducedMotion: 'reduce' });
  try {
    await page.setContent(`<style>${css}</style><style>
      body { margin:0; font:14px system-ui; color:${theme === 'dark' ? '#dededb' : '#37352f'}; background:${theme === 'dark' ? '#1d1f1c' : '#fff'}; }
      main { margin:64px auto; width:600px; --blok-editor-gutter-start:56px; --blok-editor-gutter-end:0px;
        --blok-skeleton-bar:${theme === 'dark' ? 'rgba(255,255,255,.06)' : 'rgba(55,53,47,.07)'}; --blok-space-1:4px; --blok-space-2:8px; --blok-space-4:16px; }
      [data-blok-database-drawer-content] { display:block; padding:0; }
      h1 { font-size:32px; margin:0 0 24px; }
      [data-blok-database-drawer-prop-head] { width:160px; }
      [data-blok-database-drawer-prop-value] { flex:1; }
      [data-blok-database-drawer-region] { margin-bottom:32px; }
      [data-editor-surface] { position:relative; }
    </style><main><h1>🏁 Sprint #12</h1><div data-blok-database-drawer-content>
      <div data-blok-database-drawer-region>
        <div data-blok-database-drawer-prop-row><div data-blok-database-drawer-prop-head>Avancement</div><div data-blok-database-drawer-prop-value>85</div></div>
        <div data-blok-database-drawer-prop-row><div data-blok-database-drawer-prop-head>Début</div><div data-blok-database-drawer-prop-value>18 octobre 2026</div></div>
        <div data-blok-database-drawer-prop-row><div data-blok-database-drawer-prop-head>Phase</div><div data-blok-database-drawer-prop-value>Terminé</div></div>
      </div><div data-blok-database-drawer-editor></div>
    </div></main>`);
    await page.addScriptTag({ content: script });
    const before = await page.locator('[data-blok-database-drawer-region]').boundingBox();
    await page.evaluate(() => {
      const region = document.querySelector('[data-blok-database-drawer-region]');
      region?.setAttribute('data-blok-database-details-loading', '');
      region?.setAttribute('inert', '');
      region?.setAttribute('aria-hidden', 'true');
      const skeleton = (window as unknown as { Skeleton: { buildLoadingSkeleton(rows: string[]): { root: HTMLElement } } }).Skeleton.buildLoadingSkeleton(['paragraph', 'paragraph', 'paragraph']).root;
      skeleton.setAttribute('data-blok-database-body-loading', '');
      document.querySelector('[data-blok-database-drawer-editor]')?.append(skeleton);
    });
    expect(await page.locator('[data-blok-database-drawer-region]').boundingBox()).toEqual(before);
    expect(await page.locator('[data-blok-database-drawer-prop-value]').first().evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
    expect(await page.locator('[data-blok-database-drawer-prop-value]').first().evaluate(el => getComputedStyle(el, '::after').visibility)).toBe('visible');
    const bars = page.locator('[data-blok-skeleton-bar]');
    const initial = await bars.evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    expect(initial).toHaveLength(3);
    expect(initial[0].height).toBe(12);
    expect(initial[0].width).toBeGreaterThan(initial[1].width);
    expect(await bars.first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.screenshot({ path: `/tmp/blok-peek-skeleton-${theme}.png` });
    await page.evaluate(() => {
      const surface = document.createElement('div');
      surface.setAttribute('data-editor-surface', '');
      surface.append((window as unknown as { Skeleton: { buildLoadingSkeleton(rows: string[]): { root: HTMLElement } } }).Skeleton.buildLoadingSkeleton(['paragraph', 'paragraph', 'paragraph']).root);
      document.querySelector('[data-blok-database-drawer-editor]')?.replaceChildren(surface);
    });
    const mounted = await bars.evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    expect(mounted).toEqual(initial);
  } finally {
    await page.close();
  }
});
