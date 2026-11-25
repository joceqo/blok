import {afterEach, expect, it, vi} from 'vitest';
import {mountLibraryPageSheet} from './library-page-peek';

afterEach(() => {document.body.replaceChildren();});
function open() {
  const host = document.createElement('div');
  const table = document.createElement('div');
  const page = document.createElement('article');
  const text = document.createElement('textarea');
  const title = document.createElement('h1');
  title.setAttribute('contenteditable', 'true'); title.setAttribute('data-blok-testid', 'page-header-title');
  page.append(text, title); host.append(table, page); document.body.append(host);
  const actions = {pageId:'page-a', title:'Rapport', onClose:vi.fn(), onOpenFullPage:vi.fn(), onPrevious:vi.fn(), onNext:vi.fn()};
  const sheet = mountLibraryPageSheet(table, page, actions);
  const drawer = table.querySelector<HTMLElement>('[data-blok-database-drawer]')!;
  return {host, table, page, text, actions, sheet, drawer};
}

it('uses the table drawer and returns the same live editor when expanding or navigating away', () => {
  const {host, page, text, actions, sheet, drawer} = open();
  expect(drawer.getAttribute('data-peek-mode')).toBe('side');
  expect(document.activeElement).toBe(page.querySelector('h1'));
  expect(drawer.querySelector('[data-blok-database-drawer-editor]')?.contains(page)).toBe(true);
  text.value = 'Brouillon en cours';
  const previous = drawer.querySelector<HTMLButtonElement>('[data-blok-database-peek-prev]')!;
  expect(previous.disabled).toBe(true);
  sheet.setNeighbors(true, false); previous.click();
  expect(actions.onPrevious).toHaveBeenCalledOnce();
  drawer.querySelector<HTMLButtonElement>('[data-blok-database-peek-expand]')!.click();
  expect(actions.onOpenFullPage).toHaveBeenCalledOnce();
  sheet.destroy();
  expect(page.parentElement).toBe(host); expect(page.firstChild).toBe(text);
  expect(text.value).toBe('Brouillon en cours');
  expect(actions.onClose).not.toHaveBeenCalled();
});

it('closes from the shared backdrop and restores the host after its exit transition', () => {
  const {host, table, page, actions, sheet, drawer} = open();
  table.querySelector<HTMLElement>('[data-blok-database-peek-backdrop]')!.click();
  const end = new Event('transitionend'); Object.assign(end, {propertyName:'transform'});
  drawer.dispatchEvent(end);
  expect(actions.onClose).toHaveBeenCalledOnce(); expect(page.parentElement).toBe(host);
  sheet.destroy(); expect(actions.onClose).toHaveBeenCalledOnce();
});

it('keeps the workspace sheet and live page when a nested sheet closes', () => {
  const {host, page, actions, sheet, drawer} = open();
  expect(drawer.getAttribute('role')).toBe('dialog');
  const nestedTable = document.createElement('div');
  const nestedEditor = document.createElement('article');
  page.append(nestedTable, nestedEditor);
  const nested = mountLibraryPageSheet(nestedTable, nestedEditor, {...actions, pageId:'page-b', title:'Détail'});
  expect(drawer.contains(page)).toBe(true);
  expect(document.querySelectorAll('[data-blok-database-drawer]')).toHaveLength(2);
  nested.destroy();
  expect(page.contains(nestedEditor)).toBe(true);
  expect(drawer.hasAttribute('inert')).toBe(false);
  expect(actions.onClose).not.toHaveBeenCalled();
  sheet.destroy(); expect(page.parentNode).toBe(host);
});
