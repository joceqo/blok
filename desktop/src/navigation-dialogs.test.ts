import { afterEach, expect, it, vi } from 'vitest';
import { openPageCreation, openPageSearch } from './navigation-dialogs';

afterEach(() => {
  document.querySelector<HTMLButtonElement>('[data-navigation-close]')?.click();
  document.body.replaceChildren();
});

it('searches authorized titles, shows ancestry and opens the keyboard-selected result', () => {
  const onOpen = vi.fn();
  openPageSearch({
    workspaceName: 'Équipe',
    onOpen,
    pages: () => [
      { id: 'a', title: 'Guide', parentId: null },
      { id: 'b', title: 'Installer', parentId: 'a' },
      { id: 'c', title: 'Installation avancée', parentId: 'a' },
    ],
  });
  const input = document.querySelector<HTMLInputElement>('input')!;
  expect(document.activeElement).toBe(input);
  input.value = 'install';
  input.dispatchEvent(new Event('input'));
  expect(document.querySelectorAll('[data-navigation-result]')).toHaveLength(2);
  expect(document.querySelector('[data-navigation-result-path]')?.textContent).toBe('Équipe / Guide');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(onOpen).toHaveBeenCalledWith('c');
  expect(document.querySelector('[data-navigation-dialog]')).toBeNull();
});

it('does not open a result removed by a permissions refresh', () => {
  const onOpen = vi.fn();
  let pages = [{ id: 'secret', title: 'Privé', parentId: null }];
  openPageSearch({ workspaceName: 'Équipe', onOpen, pages: () => pages });
  pages = [];
  document.querySelector<HTMLButtonElement>('[data-navigation-result]')!.click();
  expect(onOpen).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[data-navigation-result]')).toHaveLength(0);
  expect(document.querySelector<HTMLElement>('[data-navigation-empty]')!.hidden).toBe(false);
});

it('keeps the private destination when creating a database and releases the modal', () => {
  const onCreate = vi.fn();
  const destination = { value: 'private', label: 'Privé', parentId: null, privatePage: true };
  openPageCreation({ destinations: [destination], destination: 'private', onCreate });
  document.querySelectorAll<HTMLButtonElement>('[data-navigation-create-option]')[1].click();
  expect(onCreate).toHaveBeenCalledWith(destination, true);
  expect(document.querySelector('[data-navigation-dialog]')).toBeNull();
});

it('searches content and restricts matches to visible pages inside the selected parent', async () => {
  const searchContent = vi.fn(async () => [
    { id: 'secret', excerpt: 'Privé' },
    { id: 'b', excerpt: 'Une aiguille' },
  ]);
  openPageSearch({
    workspaceName: 'Équipe',
    onOpen: vi.fn(),
    searchContent,
    pages: () => [
      { id: 'a', title: 'Guides', parentId: null },
      { id: 'b', title: 'Manuel', parentId: 'a' },
      { id: 'c', title: 'Aiguille', parentId: null },
    ],
  });
  const input = document.querySelector<HTMLInputElement>('[role=combobox]')!;
  input.value = 'aiguille';
  input.dispatchEvent(new Event('input'));
  await vi.waitFor(() => expect(document.querySelectorAll('[role=option]')).toHaveLength(2));
  const scope = document.querySelector<HTMLSelectElement>('.palette-select')!;
  scope.value = 'a';
  scope.dispatchEvent(new Event('change'));
  expect(document.querySelector('[role=option]')?.textContent).toContain('Manuel');
  expect(document.querySelector('.palette-excerpt')?.textContent).toBe('Une aiguille');
  document.querySelector<HTMLButtonElement>('.palette-filter')!.click();
  expect(document.querySelectorAll('[role=option]')).toHaveLength(0);
});

it('opens a conversation from Chats and keeps page actions out of that mode', () => {
  const onOpenChat = vi.fn(),
    onOpenTab = vi.fn();
  openPageSearch({
    workspaceName: 'Projet',
    onOpen: vi.fn(),
    onOpenTab,
    pageUrl: (id) => '/?page=' + id,
    pages: () => [],
    chats: () => [{ id: 'thread', title: 'Plan de recherche', excerpt: 'Documents à préparer' }],
    onOpenChat,
  });
  [...document.querySelectorAll<HTMLButtonElement>('.palette-tab')]
    .find((tab) => tab.textContent === 'Chats')!
    .click();
  expect(document.querySelector('.palette-excerpt')?.textContent).toBe('Documents à préparer');
  expect(document.querySelectorAll('.palette-action:not([hidden])')).toHaveLength(1);
  document
    .querySelector<HTMLInputElement>('[role=combobox]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(onOpenChat).toHaveBeenCalledWith('thread');
  expect(onOpenTab).not.toHaveBeenCalled();
});
