// Opt-in check for a seeded local Docker demo. Creates one page in equipe.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

function demoOrigin(port) {
  assert(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535, 'Expected a local TCP port');
  return `http://localhost:${port}`;
}
const baseURL = demoOrigin(process.env.DEMO_WEB_PORT ?? '8088');
const mailboxURL = demoOrigin(process.env.DEMO_MAIL_PORT ?? '8089');
const email = 'membre@example.test';
const base = '/api/workspaces/equipe';
const editable = '[data-blok-redactor] [contenteditable="true"]';
const title = 'Synchro Docker ' + randomUUID();
const timeout = 25_000;
const browser = await chromium.launch().catch(error => {
  if (!String(error).includes("Executable doesn't exist")) throw error;
  return chromium.launch({ channel: 'chrome' });
});
const writer = await browser.newContext({ baseURL });
try {
  // The HTTP mailbox and prior demo message identify the seeded local fixture.
  const inbox = await writer.newPage();
  await inbox.goto(mailboxURL);
  await expect(inbox.getByRole('heading', { name: 'Boîte mail locale Blok' })).toBeVisible();
  const mail = inbox.locator('article').filter({ has: inbox.getByRole('heading', { name: email, exact: true }) });
  await expect(mail, 'Run ./deploy/demo.sh start with its local mailbox and seed first').toHaveCount(1);
  const previous = await mail.innerText();
  const requestCode = () => writer.request.post('/api/auth/request-code', { data: { email }, maxRedirects: 0 });
  let sent = await requestCode();
  if (sent.status() === 429) {
    console.log('Waiting for the 45-second OTP cooldown.');
    await delay(46_000);
    sent = await requestCode();
  }
  assert.equal(sent.status(), 200, 'OTP request refused. Check the demo account and hourly limit before retrying.');
  let code;
  await expect.poll(async () => {
    await inbox.reload();
    if (await mail.count() !== 1 || await mail.innerText() === previous) return false;
    code = await mail.locator('.code').textContent();
    return /^\d{6}$/.test(code ?? '');
  }, { timeout: 15_000, message: 'A fresh code should arrive in the local demo mailbox' }).toBe(true);
  const verified = await writer.request.post('/api/auth/verify-code', { data: { email, code }, maxRedirects: 0 });
  assert.equal(verified.status(), 200, 'The demo login failed');
  await inbox.close();
  const session = await (await writer.request.get('/api/session')).json();
  assert.equal(session.user.email, email);
  assert.equal(session.workspaces.length, 1, 'Expected the dedicated single-workspace demo account');
  assert.equal(session.workspaces[0].slug, 'equipe');

  // Capture the real document WebSocket so the offline step also closes open sockets.
  await writer.addInitScript(() => {
    const sockets = new Set();
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname.startsWith('/api/blok/sync/')) {
          sockets.add(this);
          this.addEventListener('close', () => sockets.delete(this), { once: true });
        }
      }
    };
    window.disconnectDemoDocument = () => {
      for (const socket of sockets) socket.close(4000, 'Local demo offline check');
    };
  });
  const first = await writer.newPage();
  await first.goto('/?cloud=1');
  const sidebar = first.locator('[data-blok-sidebar]');
  await expect(sidebar).toBeVisible({ timeout });
  const saved = page => expect(page.locator('[data-desktop-status]')).toHaveAttribute('data-sync-state', 'connected', { timeout });
  await expect(first.locator('[data-desktop-status][data-sync-state="connected"], [data-desktop-empty]').first()).toBeAttached({ timeout });
  const index = await (await writer.request.get(base + '/index')).json();
  const existing = new Set(index.pages.map(page => page.id));
  const oldTitle = await first.locator('[data-blok-page-title]').first().elementHandles();
  await sidebar.getByRole('button', { name: 'Nouvelle page', exact: true }).first().click();
  await first.getByRole('button', { name: /Page vide/ }).click();
  await first.waitForURL(url => Boolean(url.searchParams.get('page')) && !existing.has(url.searchParams.get('page')), { timeout });
  if (oldTitle.length) await oldTitle[0].waitForElementState('hidden', { timeout });
  const id = new URL(first.url()).searchParams.get('page');
  await saved(first);
  console.log(`Created smoke page: ${first.url()}`);
  const heading = first.locator('[data-blok-page-title]').first();
  await expect(heading).toHaveAttribute('contenteditable', 'true', { timeout });
  await heading.fill(title);
  const firstBlock = first.locator(editable).first();
  await firstBlock.fill('Brouillon A');
  await firstBlock.press('End');
  await firstBlock.press('Enter');
  await first.keyboard.type('Brouillon B');

  const partner = await browser.newContext({ baseURL, storageState: await writer.storageState() });
  const second = await partner.newPage();
  await second.goto(first.url());
  const block = (page, label) => page.locator(editable).filter({ hasText: label }).first();
  await expect(block(second, 'Brouillon B')).toBeVisible({ timeout });
  await saved(first);
  await saved(second);
  await writer.setOffline(true);
  await first.evaluate(() => window.disconnectDemoDocument());
  await expect(first.locator('[data-desktop-status]')).toHaveAttribute('data-sync-state', 'offline', { timeout });
  const offlineText = 'Modification hors ligne du premier navigateur';
  const onlineText = 'Modification en ligne du second navigateur';
  await block(first, 'Brouillon A').fill(offlineText);
  await block(second, 'Brouillon B').fill(onlineText);
  await expect(second.locator('[data-blok-redactor]')).not.toContainText(offlineText);
  await writer.setOffline(false);
  for (const page of [first, second]) {
    await expect(block(page, offlineText)).toBeVisible({ timeout });
    await expect(block(page, onlineText)).toBeVisible({ timeout });
    await saved(page);
    await page.reload();
    await expect(block(page, offlineText)).toBeVisible({ timeout });
    await expect(block(page, onlineText)).toBeVisible({ timeout });
    await expect(page.locator('[data-blok-page-title]').first()).toHaveText(title, { timeout });
    await saved(page);
  }
  // Closing both live clients lets the journal project even a small document on room eviction.
  await partner.close();
  await first.close();
  await expect.poll(async () => {
    const response = await writer.request.get(`${base}/pages/${encodeURIComponent(id)}`);
    if (!response.ok()) return false;
    const doc = await response.json();
    const content = JSON.stringify(doc?.blocks ?? []);
    return content.includes(offlineText) && content.includes(onlineText);
  }, { timeout: 75_000, intervals: [500, 1000, 2000], message: 'The Node-backed page snapshot should contain both edits' }).toBe(true);
  console.log('Passed: two clients, offline edit, reconnect, reload and persisted Node snapshot.');
} finally {
  await writer.request.post('/api/auth/logout').catch(() => {});
  await browser.close();
}
