import { describe, expect, it, vi } from 'vitest';

import { createRowPageCoverChannel } from './row-page-cover';
import type { DesktopPage } from './storage';

const setup = (pages: DesktopPage[], readOnly: (pageId: string) => boolean = () => false) => {
  const save = vi.fn();
  const refresh = vi.fn();
  const channel = createRowPageCoverChannel({
    page: pageId => pages.find(page => page.id === pageId),
    readOnly,
    save,
    refresh,
  });

  return { channel, pages, save, refresh };
};

describe('a row page keeps its cover in the workspace manifest, with the page', () => {
  it('reads the page cover and its position', () => {
    const { channel } = setup([{ id: 'p', title: 'Row', parentId: null, cover: 'https://example.com/a.png', coverPosition: 30 }]);

    expect(channel.read('p')).toEqual({ cover: 'https://example.com/a.png', position: 30 });
  });

  it('reads nothing for an unknown page, or one whose cover is not an image', () => {
    const { channel } = setup([{ id: 'p', title: 'Row', parentId: null, cover: 'not a cover' }]);

    expect(channel.read('missing')).toBeUndefined();
    expect(channel.read('p')).toBeUndefined();
  });

  it('writes a cover, drops the old position with it, and redraws that page', () => {
    const { channel, pages, save, refresh } = setup([{ id: 'p', title: 'Row', parentId: null, cover: 'https://example.com/a.png', coverPosition: 30 }]);

    channel.write('p', { cover: 'https://example.com/b.png' });

    expect(pages[0].cover).toBe('https://example.com/b.png');
    expect(pages[0].coverPosition).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('p');
  });

  it('removes the cover on null, and moves it on a position alone', () => {
    const { channel, pages } = setup([{ id: 'p', title: 'Row', parentId: null, cover: 'https://example.com/a.png' }]);

    channel.write('p', { position: 70 });

    expect(pages[0].cover).toBe('https://example.com/a.png');
    expect(pages[0].coverPosition).toBe(70);

    channel.write('p', { cover: null });

    expect(pages[0].cover).toBeUndefined();
    expect(pages[0].coverPosition).toBeUndefined();
  });

  it('refuses a page this person may only read', () => {
    const { channel, pages, save } = setup([{ id: 'p', title: 'Row', parentId: null }], () => true);

    channel.write('p', { cover: 'https://example.com/b.png' });

    expect(pages[0].cover).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
});
