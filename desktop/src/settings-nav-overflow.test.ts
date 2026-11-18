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

it('truncates a long account name in the settings nav', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

  try {
    // The account tab swaps its icon and label for an avatar and a profile name,
    // so it no longer carries [data-desktop-action-label].
    await page.setContent(`<style>${shell}</style>
      <div data-desktop-settings-dialog><div data-desktop-settings-nav>
        <button data-desktop-settings-nav-item>
          <span data-profile-nav-avatar aria-hidden="true">J</span>
          <span data-profile-nav-name>jocelin.queau@nexenture-consulting-group.fr</span>
        </button>
      </div></div>`);

    const item = page.locator('[data-desktop-settings-nav-item]');
    const name = page.locator('[data-profile-nav-name]');
    const nav = page.locator('[data-desktop-settings-nav]');

    const navWidth = (await nav.boundingBox())!.width;
    const itemWidth = (await item.boundingBox())!.width;

    expect(itemWidth).toBeLessThanOrEqual(navWidth);
    // Truncated, not spilling: the box is narrower than the text it holds.
    const [clientWidth, scrollWidth] = await name.evaluate((el) => [el.clientWidth, el.scrollWidth]);

    expect(scrollWidth).toBeGreaterThan(clientWidth);
    expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    expect((await name.boundingBox())!.width).toBeLessThanOrEqual(itemWidth);
  } finally {
    await page.close();
  }
});
