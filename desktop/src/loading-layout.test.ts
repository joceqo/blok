// @vitest-environment node
import {afterAll, beforeAll, expect, it} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import {chromium, type Browser} from 'playwright';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel: 'chrome'} : {});
});
afterAll(async () => { await browser?.close(); });

const styles = ['src/shell.css', '../src/styles/isolation.css', '../src/styles/page-title.css', '../src/styles/loading.css'].map(path => readFileSync(path, 'utf8')).join('\n');

it.each([900, 480])('holds the covered page skeleton in place while icon and body chunks arrive (%s px)', async width => {
  const page = await browser.newPage({viewport: {width, height: 800}});
  try {
    await page.setContent(`<style>body{margin:0}*{box-sizing:border-box}</style><style>${styles}</style>
      <article data-desktop-document data-has-cover>
        <div data-desktop-editor><div data-blok-interface="blok" data-blok-loading aria-busy="true">
          <header data-blok-page-header><div data-blok-page-icon-row></div><h1 data-blok-page-title>Title</h1></header>
          <div data-blok-redactor></div>
          <div data-blok-loading-skeleton><div data-blok-skeleton-bar="heading"></div></div>
        </div></div>
      </article>`);
    const rect = () => page.locator('[data-blok-loading-skeleton]').boundingBox();
    const initial = await rect();
    if (!initial) throw new Error('The page skeleton must be visible');

    // A loaded row body can contain its own editor and icon. Its metadata must
    // neither move the parent skeleton nor inherit the page's cover overlap.
    await page.locator('[data-blok-redactor]').evaluate(el => {
      el.innerHTML = '<section data-row-editor><div data-blok-interface="blok"><header data-blok-page-header><div data-blok-page-icon-row data-has-icon><button data-blok-page-icon>📄</button></div></header></div></section>';
    });
    const withRowIcon = await rect();
    const rowIconMargin = await page.locator('[data-row-editor] [data-blok-page-icon-row]').evaluate(el => getComputedStyle(el).marginTop);
    expect(rowIconMargin).toBe('0px');
    await page.locator('[data-desktop-editor] > [data-blok-interface] > [data-blok-page-header] > [data-blok-page-icon-row]').evaluate(el => {el.setAttribute('data-has-icon', ''); el.innerHTML='<button data-blok-page-icon>🏃</button>';});
    const withIcon = await rect();
    await page.locator('[data-blok-redactor]').evaluate(el => {el.innerHTML='<section style="height:600px">First chunk</section>';});
    const withBody = await rect();
    await page.locator('[data-blok-interface]').evaluate(el => el.removeAttribute('data-blok-loading'));
    const fading = await rect();
    for (const box of [withRowIcon, withIcon, withBody, fading]) {
      expect(box?.y).toBeCloseTo(initial.y, 1);
      expect(box?.x).toBeCloseTo(initial.x, 1);
      expect(box?.width).toBeCloseTo(initial.width, 1);
    }
  } finally {await page.close();}
});

it('shows row-route loading beside the breadcrumb and lets the mounted row show its own skeleton', async () => {
  const page = await browser.newPage({reducedMotion: 'reduce'});
  try {
    await page.setContent(`<style>${styles}\n${readFileSync('src/row-page-navigation.css', 'utf8')}</style>
      <main data-desktop-page-canvas data-desktop-row-page>
        <div data-desktop-page-toolbar><nav data-desktop-page-breadcrumbs><ol><li>Sprint #1</li></ol></nav></div>
        <article data-desktop-document><div data-desktop-editor><div data-blok-interface="blok">
          <div data-blok-loading-skeleton><div data-blok-skeleton-bar="heading"></div></div>
          <div data-blok-redactor><div data-blok-database-drawer-editor></div></div>
        </div></div></article>
      </main>`);
    const loader = page.locator('[data-desktop-editor] > [data-blok-interface] > [data-blok-loading-skeleton]');
    const crumb = page.locator('ol');
    const indicator = () => crumb.evaluate(el => getComputedStyle(el, '::after').content);
    expect(await loader.isVisible()).toBe(false);
    expect(await indicator()).toBe('""');
    expect(await crumb.evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('none');

    const canvas = page.locator('main');
    await canvas.evaluate(el => el.removeAttribute('data-desktop-row-page'));
    expect(await loader.isVisible()).toBe(true);
    expect(await indicator()).toBe('none');

    await canvas.evaluate(el => el.setAttribute('data-desktop-row-page', ''));
    await loader.evaluate(el => document.querySelector('[data-blok-database-drawer-editor]')!.append(el));
    expect(await page.locator('[data-blok-database-drawer-editor] [data-blok-loading-skeleton]').isVisible()).toBe(true);
    expect(await indicator()).toBe('none');
  } finally { await page.close(); }
});
