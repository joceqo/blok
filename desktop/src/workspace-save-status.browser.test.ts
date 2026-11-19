// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, webkit, type Page } from 'playwright';
import type { createWorkspaceSaveStatus } from './workspace-save-status';

type FixtureWindow = Window & {
  indicator: ReturnType<typeof createWorkspaceSaveStatus>;
  updateSave: (state: 'pending' | 'saved') => void;
};

async function expectStableSaveLayout(page: Page, width: number, theme: string): Promise<void> {
  await page.setViewportSize({ width, height: 850 });
  await page.locator('[data-desktop-shell]').evaluate((el, value) => el.setAttribute('data-blok-theme', value), theme);
  const status = page.locator('[data-desktop-status]');
  const actions = page.locator('[data-desktop-page-actions]');
  const baseline = await status.boundingBox();
  const actionsBounds = await actions.boundingBox();
  const toolbar = await page.locator('[data-desktop-page-toolbar]').boundingBox();
  expect(baseline?.width).toBe(28);
  expect(toolbar?.height).toBe(44);
  for (const state of ['pending', 'saved', 'pending', 'saved'] as const) {
    await page.evaluate(value => (window as FixtureWindow).updateSave(value), state);
    expect(await status.boundingBox()).toEqual(baseline);
    expect(await actions.boundingBox()).toEqual(actionsBounds);
  }
  await page.evaluate(() => (window as FixtureWindow).updateSave('pending'));
  await page.waitForSelector('[data-desktop-status][data-sync-busy]');
  expect(await status.boundingBox()).toEqual(baseline);
  expect(await actions.boundingBox()).toEqual(actionsBounds);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animations = await status.evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length);
  expect(animations).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => (window as FixtureWindow).updateSave('saved'));
}

async function expectOfflineWarningContrast(page: Page, theme: string): Promise<void> {
  await page.locator('[data-desktop-shell]').evaluate((el, value) => el.setAttribute('data-blok-theme', value), theme);
  const contrast = await page.locator('[data-desktop-status-label]').evaluate(el => {
    if (!el.parentElement) throw new Error('Missing offline warning container');
    const luminance = (rgb: string): number => {
      const parts = rgb.match(/[\d.]+/g);
      if (!parts || parts.length < 3) throw new Error(`Expected an RGB color, got ${rgb}`);
      const channels = parts.slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(getComputedStyle(el).color);
    const background = luminance(getComputedStyle(el.parentElement).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(contrast, `${theme} offline text contrast`).toBeGreaterThanOrEqual(4.5);
}

let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
  server = await createServer({ configFile: resolve('vite.config.mjs'), server: {port: 0, strictPort: false, host: '127.0.0.1', hmr: false}, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await server?.close(); });

it.each(['chromium', 'webkit'] as const)('keeps the real page toolbar still during save bursts (%s)', async engine => {
  const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch(
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? {channel: 'chrome'} : {},
  );
  const page = await browser.newPage({viewport: {width: 1440, height: 850}});
  try {
    await page.route(origin + '/', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body></body></html>'}));
    await page.goto(origin + '/');
    await page.setContent(`<style>${readFileSync('src/shell.css','utf8')}\n${readFileSync('src/workspace-save-status.css','utf8')}</style>
      <div data-desktop-shell data-blok-theme="dark"><main data-desktop-workspace></main></div>`);
    await page.addScriptTag({type: 'module', content: `
      import { createWorkspaceSaveStatus } from '/src/workspace-save-status.ts';
      import { createPageToolbar } from '/src/page-toolbar.ts';
      const status = createWorkspaceSaveStatus(true, true);
      const toolbar = createPageToolbar([{id:'page',title:'Vue tableaux finaux touches'}],false,()=>{},undefined,()=>()=>{}, {workspaceName:'Nexenture'});
      toolbar.element.insertBefore(status.element,toolbar.element.querySelector('[data-desktop-page-actions]'));
      document.querySelector('[data-desktop-workspace]').append(toolbar.element);
      window.indicator=status;
      window.updateSave=state=>status.connection({status:'connected',save:{state,pendingOperations:state==='pending'?1:0,pendingBytes:state==='pending'?32:0,quarantinedOperations:0}});
      window.updateSave('saved');
    `});
    await page.waitForFunction(() => typeof (window as FixtureWindow).updateSave === 'function');
    const layouts = [[1440, 'dark'], [1440, 'light'], [390, 'dark'], [390, 'light']] as const;
    for (const [width, theme] of layouts) {
      await expectStableSaveLayout(page, width, theme);
    }
    await page.setViewportSize({width: 1440, height: 850});
    await page.locator('[data-desktop-shell]').evaluate(el => el.setAttribute('data-blok-theme', 'dark'));
    await page.screenshot({path: '/tmp/blok-save-status-' + engine + '.png', clip: {x: 0, y: 0, width: 1440, height: 100}});
    await page.setViewportSize({width: 390, height: 850});
    await page.evaluate(() => {
      const fixture = window as FixtureWindow;
      fixture.updateSave('pending');
      fixture.indicator.online(false);
    });
    const warning = page.locator('[data-desktop-status-label]');
    await expect(warning.isVisible()).resolves.toBe(true);
    for (const theme of ['dark', 'light']) {
      await expectOfflineWarningContrast(page, theme);
    }
    await page.locator('[data-desktop-shell]').evaluate(el => el.setAttribute('data-blok-theme', 'dark'));

    const bounds = await page.locator('[data-desktop-status]').boundingBox();
    if (!bounds) throw new Error('Missing offline warning bounds');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({path: '/tmp/blok-save-status-offline-' + engine + '.png', clip: {x: 0, y: 0, width: 390, height: 150}});
  } finally { await browser.close(); }
}, 45000);
