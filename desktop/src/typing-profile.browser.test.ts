// @vitest-environment node
// Opt-in CPU/layout diagnostic; no timing threshold in the regular test suite.
import { it, expect } from 'vitest';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function fixture(rowCount: number) {
  const groups = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, label: `Group ${i}`, color: 'blue', position: `a${i}` }));
  const schema = [
    { id: 'title', name: 'Name', type: 'title', position: 'a0' },
    { id: 'group', name: 'Group', type: 'select', position: 'a1', config: { options: groups } },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Property ${i}`, type: 'text', position: `b${i}` })),
  ];
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `row${i}`, type: 'database-row', parent: 'db',
    data: {
      properties: { title: `Commit ${i}`, group: `g${i % 5}`, ...Object.fromEntries(Array.from({ length: 6 }, (_, j) => [`p${j}`, `Value ${i} ${j}`])) },
      position: `a${String(i).padStart(4, '0')}`,
    },
  }));
  return { blocks: [
    { id: 'intro', type: 'paragraph', data: { text: 'Typing fixture. ' } },
    ...(rowCount ? [{ id: 'db', type: 'database', content: rows.map(row => row.id), data: {
      title: 'Commits', schema, activeViewId: 'v', views: [{ id: 'v', name: 'Table', type: 'table', position: 'a0', sorts: [], filters: [], groupBy: 'group', loadLimit: 200, properties: schema.map(property => ({ id: property.id, visible: true, width: 200 })) }],
    } }, ...rows] : []),
  ] };
}

it.skipIf(process.env.BLOK_PROFILE_TYPING !== '1')('profiles ten keystrokes in the full local workspace', async () => {
  const output = process.env.BLOK_TYPING_OUTPUT ?? tmpdir();
  mkdirSync(output, { recursive: true });
  const documentPath = process.env.BLOK_TYPING_DOCUMENT;
  const cases = [
    { name: 'empty', data: fixture(0) },
    { name: 'database', data: fixture(140) },
    ...(documentPath ? [{ name: 'document', data: JSON.parse(readFileSync(documentPath, 'utf8')) }] : []),
  ].filter(item => !process.env.BLOK_TYPING_CASE || item.name === process.env.BLOK_TYPING_CASE);
  if (cases.length === 0) throw new Error('No profiling case selected');
  const server = await createServer({ configFile: resolve('vite.config.mjs'), server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('No fixture server');
    const browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
    try {
      for (const item of cases) {
        const page = await browser.newPage({ viewport: { width: 1512, height: 850 } });
        page.setDefaultTimeout(10000);
        try {
          const url = `http://127.0.0.1:${address.port}/fixture`;
          await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
          await page.goto(url);
          await page.addScriptTag({ type: 'module', content: `
            import { createWorkspace } from '/src/workspace.ts';
            import '/src/shell.css';
            const data = ${JSON.stringify(item.data)};
            const input = data.blocks.find(block => block.type === 'paragraph' && !block.parent);
            if (!input) throw new Error('Fixture needs a root paragraph');
            window.inputId = input.id;
            localStorage.setItem('blok:workspace:typing:index', JSON.stringify({ pages: [
              { id: 'fixture-page', title: 'Typing fixture', parentId: null },
              ...Array.from({ length: 200 }, (_, i) => ({ id: 'page-' + i, title: 'Page ' + i, parentId: null }))
            ], activeId: 'fixture-page' }));
            localStorage.setItem('blok:workspace:typing:fixture-page', JSON.stringify(data));
            history.replaceState(null, '', '?page=fixture-page');
            const workspace = createWorkspace(() => {}, () => {}, { ref: { kind: 'local', id: 'typing', name: 'Typing fixture' } });
            document.body.replaceChildren(workspace.element);
            await workspace.start();
            window.samples = [];
            document.addEventListener('keydown', event => {
              if (event.key.length !== 1 || event.ctrlKey || event.metaKey) return;
              const start = performance.now();
              requestAnimationFrame(() => requestAnimationFrame(() => window.samples.push(performance.now() - start)));
            });
            window.ready = true;
          ` });
          await page.waitForFunction(() => Reflect.get(window, 'ready') === true);
          const inputId = await page.evaluate(() => Reflect.get(window, 'inputId') as string);
          const input = page.locator(`[data-blok-id="${inputId}"] [contenteditable="true"]`).first();
          await input.click();
          await input.press('End');
          if (process.env.BLOK_TYPING_STYLE) await page.addStyleTag({ content: process.env.BLOK_TYPING_STYLE });
          await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const session = await page.context().newCDPSession(page);
          await session.send('Tracing.start', { categories: 'devtools.timeline,blink,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReturnAsStream' });
          await session.send('Profiler.enable');
          await session.send('Profiler.setSamplingInterval', { interval: 1000 });
          await session.send('Profiler.start');
          await input.pressSequentially('abcdefghij', { delay: 100 });
          await page.waitForFunction(() => (Reflect.get(window, 'samples') as number[]).length >= 10);
          const { profile } = await session.send('Profiler.stop');
          writeFileSync(join(output, `blok-typing-${item.name}.cpuprofile`), JSON.stringify(profile));
          const completed = new Promise<{ stream?: string }>(done => session.once('Tracing.tracingComplete', done));
          await session.send('Tracing.end');
          const { stream } = await completed;
          if (stream === undefined) throw new Error('Tracing completed without a readable stream');
          let trace = '';
          for (;;) {
            const part = await session.send('IO.read', { handle: stream });
            trace += part.data;
            if (part.eof) break;
          }
          await session.send('IO.close', { handle: stream });
          writeFileSync(join(output, `blok-typing-${item.name}.trace.json`), trace);
          const metrics = await page.evaluate(() => ({
            latencies: Reflect.get(window, 'samples') as number[],
            nodes: document.querySelectorAll('*').length,
            rows: document.querySelectorAll('[data-blok-database-table-row]').length,
          }));
          writeFileSync(join(output, `blok-typing-${item.name}.json`), JSON.stringify(metrics));
          expect(await input.textContent()).toContain('abcdefghij');
          expect(metrics.latencies).toHaveLength(10);
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.close(); }
}, 90000);
