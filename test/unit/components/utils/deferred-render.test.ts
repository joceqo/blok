import { afterEach, expect, it, vi } from 'vitest';
import { DEFERRED_RENDER_EVENT, renderDeferredDescendants, scheduleDeferredDescendants } from '../../../../src/components/utils/deferred-render';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it('yields between expensive tools, including recursively requested descendants', async () => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const root = document.createElement('div');
  document.body.append(root);
  const rendered: number[] = [];
  let parent = root;
  for (let i = 0; i < 8; i++) {
    const child = document.createElement('div');
    child.setAttribute('data-blok-deferred-render', '');
    parent.append(child);
    child.addEventListener(DEFERRED_RENDER_EVENT, () => {
      child.removeAttribute('data-blok-deferred-render');
      rendered.push(i);
      clock += 5;
      renderDeferredDescendants(child);
    });
    parent = child;
  }
  const idle = vi.fn();
  const cancel = scheduleDeferredDescendants(root, { isCurrent: () => true, onIdle: idle });
  expect(rendered).toEqual([0, 1]);
  expect(idle).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(rendered).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(idle).toHaveBeenCalledOnce();
  cancel();
});

it.each(['cancel', 'moved', 'removed'] as const)('does not wake remaining blocks after the body is %s', async reason => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const root = document.createElement('div');
  document.body.append(root);
  const wake = vi.fn();
  for (let i = 0; i < 5; i++) {
    const child = document.createElement('div');
    child.setAttribute('data-blok-deferred-render', '');
    root.append(child);
    child.addEventListener(DEFERRED_RENDER_EVENT, () => { child.removeAttribute('data-blok-deferred-render'); wake(); clock += 10; });
  }
  let current = true;
  const cancel = scheduleDeferredDescendants(root, { isCurrent: () => current });
  expect(wake).toHaveBeenCalledOnce();
  if (reason === 'cancel') cancel();
  if (reason === 'moved') current = false;
  if (reason === 'removed') root.remove();
  await vi.runAllTimersAsync();
  expect(wake).toHaveBeenCalledOnce();
  renderDeferredDescendants(root); // late async rendered hook after close
  await vi.runAllTimersAsync();
  expect(wake).toHaveBeenCalledOnce();
  cancel();
  current = true;
  document.body.append(root);
  const reopened = scheduleDeferredDescendants(root, { isCurrent: () => current });
  await vi.runAllTimersAsync();
  expect(wake).toHaveBeenCalledTimes(5);
  reopened();
});

it('keeps closed nested rows asleep and admits children arriving after an async tool renders', async () => {
  vi.useFakeTimers();
  const root = document.createElement('div');
  document.body.append(root);
  const closed = document.createElement('div');
  closed.setAttribute('data-blok-deferred-render', '');
  root.append(closed);
  const untouched = vi.fn();
  closed.addEventListener(DEFERRED_RENDER_EVENT, untouched);
  const cancel = scheduleDeferredDescendants(root, { isCurrent: () => true });
  expect(closed.hasAttribute('data-blok-deferred-render')).toBe(true);
  const late = document.createElement('div');
  late.setAttribute('data-blok-deferred-render', '');
  root.append(late);
  const wake = vi.fn(() => late.removeAttribute('data-blok-deferred-render'));
  late.addEventListener(DEFERRED_RENDER_EVENT, wake);
  renderDeferredDescendants(root);
  expect(wake).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(wake).toHaveBeenCalledOnce();
  expect(untouched).toHaveBeenCalledTimes(2);
  cancel();
});
