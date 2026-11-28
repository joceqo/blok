import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createElement } from 'react';
import { SidebarChats } from './sidebar-chats';

const render = (props: Parameters<typeof SidebarChats>[0]) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SidebarChats, props)));
  return { host, done: () => { flushSync(() => root.unmount()); host.remove(); } };
};

describe('sidebar chat list', () => {
  const chats = [
    { id: 'a', title: 'Préparer la revue', excerpt: 'On commence par…' },
    { id: 'b', title: '', excerpt: 'Sans titre encore' },
  ];

  it('lists the conversations, newest first, and opens the one picked', () => {
    const onOpen = vi.fn();
    const { host, done } = render({ chats: () => chats, onOpen, onNew: vi.fn() });

    const rows = [...host.querySelectorAll('[data-blok-sidebar-chat]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Sans titre encore');

    (rows[1] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith('a');
    done();
  });

  it('names a conversation that has no title yet by what was said in it', () => {
    const { host, done } = render({ chats: () => chats, onOpen: vi.fn(), onNew: vi.fn() });
    const untitled = host.querySelector('[data-blok-sidebar-chat="b"]');
    expect(untitled?.textContent).toContain('Sans titre encore');
    done();
  });

  it('offers to start one, and says so when there are none', () => {
    const onNew = vi.fn();
    const { host, done } = render({ chats: () => [], onOpen: vi.fn(), onNew });

    expect(host.querySelectorAll('[data-blok-sidebar-chat]')).toHaveLength(0);
    const start = host.querySelector<HTMLButtonElement>('[data-blok-sidebar-new-chat]');
    expect(start).not.toBeNull();
    start?.click();
    expect(onNew).toHaveBeenCalled();
    done();
  });
});
