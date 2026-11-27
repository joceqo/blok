import { describe, expect, it, vi } from 'vitest';
import { createCitedBlockNavigator, type CitedBlockEditor } from './cited-block';

function fakeEditor(blockIds: string[]) {
  const holders = new Map<string, HTMLElement>();
  const scrolls = new Map<string, ReturnType<typeof vi.fn<HTMLElement['scrollIntoView']>>>();
  for (const id of blockIds) {
    const holder = document.createElement('div');
    const scrollIntoView = vi.fn<HTMLElement['scrollIntoView']>();
    holder.scrollIntoView = scrollIntoView;
    holders.set(id, holder);
    scrolls.set(id, scrollIntoView);
  }
  let open = (): void => undefined;
  const ready = new Promise<void>((resolve) => { open = resolve; });
  const setToBlock = vi.fn<(id: string, position?: 'start') => boolean>(() => true);
  const editor: CitedBlockEditor = {
    isReady: ready,
    blocks: { getById: (id) => { const holder = holders.get(id); return holder ? { holder } : null; } },
    caret: { setToBlock },
  };
  return {
    editor,
    setToBlock,
    scrollOf: (id: string) => scrolls.get(id),
    async mount(): Promise<void> {
      open();
      await ready;
      await Promise.resolve();
    },
  };
}

function fakeHost(mountedPageId: string | null = null, mounted: CitedBlockEditor | null = null) {
  const navigate = vi.fn<(pageId: string) => void>();
  let turn = 0;
  return {
    navigate,
    mountedEditor: (pageId: string): CitedBlockEditor | null => (pageId === mountedPageId ? mounted : null),
    generation: () => turn,
    leave(): void { turn++; },
  };
}

describe('cited block navigation', () => {
  it('amène le lecteur jusqu’au bloc cité une fois la page ouverte', async () => {
    const page = fakeEditor(['intro', 'cited']);
    const host = fakeHost();
    const navigator = createCitedBlockNavigator(host);

    navigator.open('report', 'cited');
    navigator.pageMounted('report', page.editor);
    await page.mount();

    expect(page.scrollOf('cited')).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(page.setToBlock).toHaveBeenCalledWith('cited', 'start');
    expect(host.navigate).toHaveBeenCalledWith('report');
  });

  it('défile tout de suite quand la page citée est déjà ouverte', async () => {
    const page = fakeEditor(['cited']);
    const host = fakeHost('report', page.editor);
    const navigator = createCitedBlockNavigator(host);

    navigator.open('report', 'cited');
    await page.mount();

    expect(page.scrollOf('cited')).toHaveBeenCalled();
    expect(host.navigate).toHaveBeenCalledWith('report');
  });

  it('ouvre la page sans défiler quand la source ne cite aucun bloc', async () => {
    const page = fakeEditor(['cited']);
    const host = fakeHost();
    const navigator = createCitedBlockNavigator(host);

    navigator.open('report');
    navigator.pageMounted('report', page.editor);
    await page.mount();

    expect(page.scrollOf('cited')).not.toHaveBeenCalled();
    expect(page.setToBlock).not.toHaveBeenCalled();
    expect(host.navigate).toHaveBeenCalledWith('report');
  });

  it('ouvre la page sans erreur quand le bloc cité a été supprimé', async () => {
    const page = fakeEditor(['intro']);
    const host = fakeHost();
    const navigator = createCitedBlockNavigator(host);

    navigator.open('report', 'disparu');
    navigator.pageMounted('report', page.editor);
    await page.mount();

    expect(page.setToBlock).not.toHaveBeenCalled();
    expect(host.navigate).toHaveBeenCalledWith('report');
  });

  it('ne défile pas quand le lecteur est parti ailleurs pendant le chargement', async () => {
    const page = fakeEditor(['cited']);
    const host = fakeHost();
    const navigator = createCitedBlockNavigator(host);

    navigator.open('report', 'cited');
    navigator.pageMounted('report', page.editor);
    host.leave();
    await page.mount();

    expect(page.scrollOf('cited')).not.toHaveBeenCalled();
    expect(page.setToBlock).not.toHaveBeenCalled();
  });

  it('oublie la citation dès qu’une autre page est montée', async () => {
    const other = fakeEditor(['cited']);
    const cited = fakeEditor(['cited']);
    const host = fakeHost();
    const navigator = createCitedBlockNavigator(host);

    navigator.open('report', 'cited');
    navigator.pageMounted('notes', other.editor);
    await other.mount();
    navigator.pageMounted('report', cited.editor);
    await cited.mount();

    expect(other.scrollOf('cited')).not.toHaveBeenCalled();
    expect(cited.scrollOf('cited')).not.toHaveBeenCalled();
  });
});
