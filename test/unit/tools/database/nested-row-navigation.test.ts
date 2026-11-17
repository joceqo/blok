import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseCardDrawer, type CardDrawerOptions } from '../../../../src/tools/database/database-card-drawer';

const drawers: DatabaseCardDrawer[] = [];
const make = (wrapper: HTMLElement): DatabaseCardDrawer => {
  const options: CardDrawerOptions = { wrapper, readOnly: false, titlePropertyId: 'title', schema: [], onTitleChange: vi.fn(), onDescriptionChange: vi.fn(), onClose: vi.fn() };
  const drawer = new DatabaseCardDrawer(options);
  drawers.push(drawer);
  return drawer;
};
beforeEach(() => { vi.clearAllMocks(); history.replaceState(null, '', '/'); });
afterEach(() => { drawers.splice(0).reverse().forEach(drawer => drawer.destroy()); document.body.replaceChildren(); history.replaceState(null, '', '/'); vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps the full sprint page open when a task from another database opens in a peek', () => {
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const sprint = document.createElement('div'), tasks = document.createElement('div');
  editor.append(sprint, tasks); document.body.append(editor);
  const parent = make(sprint), child = make(tasks);
  parent.open({ id: 'sprint', position: 'a0', properties: { title: 'Sprint #14' } }, 'full');
  const parentElement = sprint.querySelector<HTMLElement>('[data-blok-database-drawer]');
  parentElement?.setAttribute('data-open', '');
  child.open({ id: 'task', position: 'a0', properties: { title: 'Task' } }, 'side');
  expect(parent.isOpen).toBe(true);
  expect(parent.openRowId).toBe('sprint');
  expect(location.hash).toBe('#sprint?full');
  child.close();
  expect(parent.isOpen).toBe(true);
  expect(location.hash).toBe('#sprint?full');
});

it('expands an existing peek without waiting for its close animation', () => {
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const wrapper = document.createElement('div'); editor.append(wrapper); document.body.append(editor);
  const drawer = make(wrapper);
  drawer.open({ id: 'sprint', position: 'a0', properties: { title: 'Sprint #14' } }, 'side');
  wrapper.querySelector('[data-blok-database-drawer]')?.setAttribute('data-open', '');
  wrapper.querySelector<HTMLButtonElement>('[data-blok-database-peek-expand]')?.click();
  expect(drawer.openMode).toBe('full');
  expect(location.hash).toBe('#sprint?full');
});

it('keeps only the foreground peek listening to row shortcuts and Escape', () => {
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const sprint = document.createElement('div'), tasks = document.createElement('div');
  editor.append(sprint, tasks); document.body.append(editor);
  const parent = make(sprint), child = make(tasks);
  parent.open({ id: 'sprint', position: 'a0', properties: { title: 'Sprint' } }, 'full');
  child.open({ id: 'task', position: 'a0', properties: { title: 'Task' } }, 'side');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(child.isOpen).toBe(false);
  expect(parent.isOpen).toBe(true);
  expect(editor.hasAttribute('data-blok-database-row-page')).toBe(true);
  expect(sprint.closest('[inert]')).toBeNull();
});

it('keeps the parent body mounted through child full-page navigation and Back', () => {
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const sprint = document.createElement('div'), tasks = document.createElement('div');
  editor.append(sprint, tasks); document.body.append(editor);
  const parent = make(sprint), child = make(tasks);
  parent.open({ id: 'sprint', position: 'a0', properties: { title: 'Sprint' } }, 'full');
  const parentPanel = sprint.querySelector<HTMLElement>('[data-blok-database-drawer]');
  child.open({ id: 'task', position: 'a0', properties: { title: 'Task' } }, 'side');
  editor.scrollTop = 420;
  child.open({ id: 'task', position: 'a0', properties: { title: 'Task' } }, 'full');
  editor.scrollTop = 0;
  expect(parent.isOpen).toBe(true);
  expect(parent.hasFullPageChild('task')).toBe(true);
  expect(parentPanel?.hasAttribute('data-blok-database-full-page')).toBe(true);
  expect(location.hash).toBe('#task?full');
  // Browser Back has already changed the URL when the database closes the child.
  history.replaceState(null, '', '/#sprint?full');
  child.close();
  expect(parent.isOpen).toBe(true);
  expect(parentPanel?.hasAttribute('data-blok-database-full-page')).toBe(false);
  expect(editor.scrollTop).toBe(420);
  expect(editor.hasAttribute('data-blok-database-row-page')).toBe(true);
  expect(location.hash).toBe('#sprint?full');
});

it('paints a row shell before mounting its expensive body, and cancels a closed row', () => {
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const wrapper = document.createElement('div'); editor.append(wrapper); document.body.append(editor);
  const attach = vi.fn(() => true);
  const drawer = new DatabaseCardDrawer({ wrapper, readOnly: false, titlePropertyId: 'title', schema: [], onTitleChange: vi.fn(), onDescriptionChange: vi.fn(), onClose: vi.fn(), rowBody: { attach, detach: vi.fn() } });
  drawers.push(drawer);
  drawer.open({ id: 'sprint', position: 'a0', properties: { title: 'Sprint' } }, 'side');
  expect(wrapper.querySelector('[data-blok-database-drawer-title]')).not.toBeNull();
  expect(attach).not.toHaveBeenCalled();
  drawer.close();
  expect(attach).not.toHaveBeenCalled();
});


it('mounts only the latest row after paint and never saves a cancelled empty body', async () => {
  vi.useFakeTimers();
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const wrapper = document.createElement('div'); editor.append(wrapper); document.body.append(editor);
  const attach = vi.fn(() => true), save = vi.fn();
  const drawer = new DatabaseCardDrawer({ wrapper, readOnly: false, titlePropertyId: 'title', schema: [], onTitleChange: vi.fn(), onDescriptionChange: save, onClose: vi.fn(), rowBody: { attach, detach: vi.fn() } });
  drawers.push(drawer);
  drawer.open({ id: 'first', position: 'a0', properties: { title: 'First' } }, 'side');
  drawer.open({ id: 'second', position: 'a1', properties: { title: 'Second' } }, 'side');
  expect(attach).not.toHaveBeenCalled();
  expect(wrapper.querySelector('[aria-busy="true"]')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(40);
  expect(attach).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledWith('second', expect.any(HTMLElement));
  expect(wrapper.querySelector('[aria-busy="true"]')).toBeNull();
  drawer.open({ id: 'cancelled', position: 'a2', properties: { title: 'Cancelled' } }, 'side');
  drawer.close();
  await vi.advanceTimersByTimeAsync(40);
  expect(attach).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

it('paints the row shell before mounting a host page body', async () => {
  vi.useFakeTimers();
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const wrapper = document.createElement('div'); editor.append(wrapper); document.body.append(editor);
  const mount = vi.fn(() => ({ destroy: vi.fn() }));
  const rowPages: CardDrawerOptions['rowPages'] = {
    lookup: async () => null,
    copyFromLegacy: async () => { throw new Error('unused'); },
    reconcileLegacy: async () => { throw new Error('unused'); },
    mount,
  };
  const drawer = new DatabaseCardDrawer({ wrapper, readOnly: false, titlePropertyId: 'title', schema: [], onTitleChange: vi.fn(), onDescriptionChange: vi.fn(), onClose: vi.fn(), rowPages });
  drawers.push(drawer);
  drawer.open({ id: 'sprint', position: 'a0', pageId: 'body-1', properties: { title: 'Sprint #14' } }, 'side');
  // Building a page editor in the click's own tick freezes the list behind the peek.
  expect(mount).not.toHaveBeenCalled();
  expect(wrapper.querySelector('[data-blok-database-drawer-title]')).not.toBeNull();
  expect(wrapper.querySelector('[aria-busy="true"]')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(40);
  expect(mount).toHaveBeenCalledWith('body-1', expect.any(HTMLElement));
  expect(wrapper.querySelector('[aria-busy="true"]')).toBeNull();
});

it('paints the peek before measuring its toolbar and its title', async () => {
  vi.useFakeTimers();
  const editor = document.createElement('div'); editor.setAttribute('data-blok-editor', '');
  const wrapper = document.createElement('div'); editor.append(wrapper); document.body.append(editor);
  const rowPages: CardDrawerOptions['rowPages'] = {
    lookup: async () => null,
    copyFromLegacy: async () => { throw new Error('unused'); },
    reconcileLegacy: async () => { throw new Error('unused'); },
    mount: vi.fn(() => ({ destroy: vi.fn() })),
  };
  const drawer = new DatabaseCardDrawer({ wrapper, readOnly: false, titlePropertyId: 'title', schema: [], onTitleChange: vi.fn(), onDescriptionChange: vi.fn(), onClose: vi.fn(), rowPages });

  drawers.push(drawer);
  drawer.open({ id: 'sprint', position: 'a0', properties: { title: 'Sprint #14' } }, 'side');
  const panel = wrapper.querySelector<HTMLElement>('[data-blok-database-drawer]');
  const title = wrapper.querySelector<HTMLTextAreaElement>('[data-blok-database-drawer-title]');

  // Reading offsetHeight/scrollHeight here forces a full layout of the page behind the peek.
  expect(panel?.style.getPropertyValue('--_blok-peek-toolbar-size')).toBe('');
  expect(title?.style.height).toBe('');
  vi.advanceTimersToNextFrame();
  // Animation-frame callbacks run before paint. Geometry must wait for the
  // subsequent task, after the shell has had an opportunity to paint.
  expect(panel?.hasAttribute('data-open')).toBe(true);
  expect(panel?.style.getPropertyValue('--_blok-peek-toolbar-size')).toBe('');
  expect(title?.style.height).toBe('');
  await vi.advanceTimersByTimeAsync(40);
  expect(panel?.style.getPropertyValue('--_blok-peek-toolbar-size')).not.toBe('');
  expect(title?.style.height).not.toBe('');
});

it.each([false, true])('cancels geometry reads when a peek closes (frame already run: %s)', async (afterFrame) => {
  vi.useFakeTimers();
  const wrapper = document.createElement('div');
  document.body.append(wrapper);
  const drawer = make(wrapper);
  drawer.open({ id: 'sprint', position: 'a0', properties: { title: 'Sprint' } }, 'side');
  const title = wrapper.querySelector<HTMLTextAreaElement>('[data-blok-database-drawer-title]');
  if (title === null) throw new Error('missing title');
  const measure = vi.fn(() => 48);
  Object.defineProperty(title, 'scrollHeight', { configurable: true, get: measure });

  if (afterFrame) vi.advanceTimersToNextFrame();
  drawer.close();
  await vi.advanceTimersByTimeAsync(40);

  expect(measure).not.toHaveBeenCalled();
});
