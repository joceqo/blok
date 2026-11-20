// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';

let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
  server = await createServer({ configFile: resolve('vite.config.mjs'), server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await server?.close(); });

// The annotation is in the left cell of a table, and the page scrolls: the two
// defects the overlay had. The badge belongs in the page margin — the right
// edge of ITS block is the next cell's text — and both badge and highlight
// must travel WITH the content, not be repainted a frame behind it.
const fixture = `<!doctype html><html><body style="margin:0">
  <main data-canvas style="height:600px;overflow:auto">
    <article style="box-sizing:border-box;width:900px;margin:0 auto;padding:30px 64px 400px">
      <div data-blok-interface><div data-blok-editor>
        <div data-blok-id="table"><table style="width:100%;table-layout:fixed;border-collapse:collapse">
          <tbody><tr>
            <td style="border:1px solid #ccc;padding:8px"><div data-blok-id="sondage"><p data-text contenteditable="true" style="margin:0">Vote une fois, sans retour possible</p></div></td>
            <td style="border:1px solid #ccc;padding:8px"><div data-blok-id="quiz"><p data-neighbour contenteditable="true" style="margin:0">Répond à la question posée</p></div></td>
          </tr></tbody>
        </table></div>
        <div style="height:1400px"></div>
      </div></div>
    </article>
  </main>
</body></html>`;

const script = `
  import { mountInlineComments } from '/src/inline-comments.ts';
  const anchor = { segments: [{ blockId: 'sondage', field: 0, start: 0, quote: 'Vote une fois, sans retour possible', prefix: '', suffix: '' }] };
  const comment = { id: 'c1', name: 'database-comment', parentId: null,
    call: (method, payload) => { if (method === 'readData') payload.receive({ text: 'Et le retour ?', createdAt: 1, anchor }); } };
  const editor = {
    blocks: { transactWithoutCapture: () => {}, getBlocksCount: () => 1, getBlockByIndex: index => (index === 0 ? comment : undefined),
      getById: id => (id === 'c1' ? comment : undefined), getChildren: () => [] },
    tools: { getBlockTools: () => [{ name: 'database-comment' }] },
    events: { on: () => {}, off: () => {} },
    i18n: { t: key => key },
  };
  mountInlineComments({ holder: document.querySelector('[data-blok-interface]'), editor,
    author: () => ({ authorId: 'me', authorName: 'Moi' }), canComment: () => true });
  window.ready = true;
`;

it('hangs the badge in the page margin and scrolls the overlay with the text', async () => {
  const browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  page.setDefaultTimeout(5000);
  try {
    await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto(origin + '/');
    await page.addScriptTag({ type: 'module', content: script });
    await page.waitForFunction(() => Reflect.get(window, 'ready') === true);
    await page.locator('[data-inline-comment-badge]').waitFor();

    const placed = await page.evaluate(() => {
      const box = (selector: string): DOMRect => {
        const found = document.querySelector(selector);
        if (!found) throw new Error(`Missing ${selector}`);
        return found.getBoundingClientRect();
      };
      return { badge: box('[data-inline-comment-badge]').left, neighbour: box('[data-neighbour]').right,
        table: box('[data-blok-id="table"]').right, article: box('article').right };
    });
    expect(placed.badge).toBeGreaterThanOrEqual(placed.neighbour); // never over the next cell
    expect(placed.badge).toBeGreaterThanOrEqual(placed.table);     // out in the margin
    expect(placed.badge).toBeLessThan(placed.article);             // and not clipped away

    // Measured in the SAME task as the scroll: a repaint scheduled for the next
    // frame has not run, so this is exactly what the user sees mid-gesture.
    const scrolled = await page.evaluate(() => {
      const canvas = document.querySelector('[data-canvas]');
      if (!canvas) throw new Error('Missing canvas');
      canvas.scrollTop = 240;
      const box = (selector: string): DOMRect => {
        const found = document.querySelector(selector);
        if (!found) throw new Error(`Missing ${selector}`);
        return found.getBoundingClientRect();
      };
      return { text: box('[data-text]').top, mark: box('[data-inline-comment-highlight]').top, badge: box('[data-inline-comment-badge]').top };
    });
    expect(Math.abs(scrolled.mark - scrolled.text)).toBeLessThan(2);
    expect(Math.abs(scrolled.badge - scrolled.text)).toBeLessThan(2);
  } finally { await browser.close(); }
}, 60_000);
