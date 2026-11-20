// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {});
});
afterAll(async () => { await browser?.close(); });

const core = readFileSync('../src/styles/main.css', 'utf8');
const database = readFileSync('../src/styles/database.css', 'utf8');
const shell = readFileSync('src/shell.css', 'utf8');
const rowPage = readFileSync('src/row-page-navigation.css', 'utf8');

// A row opened full page is a page, so its cover spans the canvas: the HOST
// editor gives up the 56px gutter it keeps for the floating +/⠿ controls.
// The drawer's own editor must keep one — that gutter is what lines its blocks
// up with the property rows printed above them. Zeroing padding on every
// redactor under the full page took it from the drawer too, and the body hung
// a whole gutter to the left of its own properties.
const page = (gutter: string) => `<style>${core}</style><style>${database}</style><style>${shell}</style><style>${rowPage}</style><style>
  [data-desktop-page-canvas] { margin-left: 260px; width: 1252px; }
  [data-blok-database-drawer][data-peek-mode="full"] { display: block; }
  [data-blok-database-drawer-content] { max-width: 732px; margin-inline: auto; }
  [data-blok-database-drawer-prop-row] { height: 20px; }
</style><main data-desktop-page-canvas data-desktop-row-page><article data-desktop-document>
  <div data-desktop-editor><div data-blok-interface style="${gutter}"><div data-blok-redactor>
    <div data-blok-element><div data-blok-element-content>
      <div data-blok-tool data-blok-database-wrapper data-blok-database-full-page>
        <div data-blok-database-drawer data-peek-mode="full" data-open>
          <div data-blok-database-drawer-content>
            <div data-blok-database-drawer-props data-blok-database-drawer-region>
              <div data-blok-database-drawer-prop-row data-props>Référence</div>
            </div>
            <div data-blok-database-drawer-editor><div data-blok-interface><div data-blok-redactor>
              <div data-blok-element><div data-blok-element-content data-body>Le corps de la page</div></div>
            </div></div></div>
          </div>
        </div>
      </div>
    </div></div>
  </div></div></div>
</article></main>`;

async function box(tab: Awaited<ReturnType<Browser['newPage']>>, selector: string): Promise<{ x: number; width: number }> {
  const measured = await tab.locator(selector).boundingBox();
  if (!measured) throw new Error(`No box for ${selector}`);
  return measured;
}

it('lines a full-page row body up with its property rows', async () => {
  const tab = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  try {
    await tab.setContent(page(''));
    const props = await box(tab, '[data-props]');
    const body = await box(tab, '[data-body]');
    // The defect was a whole 56px gutter wide; a few pixels of padding are not.
    expect(Math.abs(body.x - props.x)).toBeLessThan(8);
  } finally { await tab.close(); }
});

it('keeps the host editor flush with the canvas so the cover spans it', async () => {
  const tab = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  try {
    await tab.setContent(page(''));
    const canvas = await box(tab, '[data-desktop-page-canvas]');
    const drawer = await box(tab, '[data-blok-database-drawer]');
    expect(drawer.x).toBeCloseTo(canvas.x, 0);
    expect(drawer.width).toBeCloseTo(canvas.width, 0);
  } finally { await tab.close(); }
});

it('leaves a host that declares its own gutter alone', async () => {
  // The rule must zero the gutter, not override padding: a host that sets the
  // variable itself still wins, and the drawer still gets its own.
  const tab = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  try {
    await tab.setContent(page('--blok-editor-gutter-start: 24px;'));
    const hostPadding = await tab.locator('[data-desktop-editor] > [data-blok-interface] > [data-blok-redactor]')
      .evaluate(el => getComputedStyle(el).paddingInlineStart);
    const drawerPadding = await tab.locator('[data-blok-database-drawer-editor] [data-blok-redactor]')
      .evaluate(el => getComputedStyle(el).paddingInlineStart);
    expect(hostPadding).toBe('24px');
    expect(drawerPadding).toBe('56px');
  } finally { await tab.close(); }
});
