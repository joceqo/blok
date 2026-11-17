import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseTool } from '../../../../src/tools/database';
import { beginDocumentMount, endDocumentMount, isDocumentMounting } from '../../../../src/components/utils/document-mount';

afterEach(() => {
  while (isDocumentMounting()) {
    endDocumentMount();
  }
  vi.restoreAllMocks();
});

/**
 * Loading a page emits DATABASE_RENDERED once per database that comes up, and
 * the mount re-emits one for the source as each block inside it activates:
 * 44 full rebuilds of a linked view on one load, 34 of them from this handler,
 * ~51 ms each.
 *
 * Folding that burst was measured and made it worse (25 rebuilds to 47), and
 * comparing readings of the source removed nothing — the source is being
 * FILLED as it renders, so all 34 readings genuinely differed. They were 34
 * states on the way to a single result, so the wait has to be on the mount.
 */
describe('redraw d’une vue liée', () => {
  const standUp = (): {
    internals: { redrawFromSource(): void; destroyed: boolean };
    rerender: ReturnType<typeof vi.fn>;
    rebuildTabs: ReturnType<typeof vi.fn>;
  } => {
    const tool = Object.create(DatabaseTool.prototype) as DatabaseTool;
    const internals = tool as never as {
      redrawFromSource(): void;
      destroyed: boolean;
      redrawAfterMount: boolean;
    };

    internals.destroyed = false;
    internals.redrawAfterMount = false;

    const rerender = vi.fn();
    const rebuildTabs = vi.fn();

    Object.assign(internals, { rerenderView: rerender, rebuildTabBar: rebuildTabs });

    return { internals, rerender, rebuildTabs };
  };

  it('ne redessine qu’une fois pour toute une rafale de montage', () => {
    const { internals, rerender, rebuildTabs } = standUp();

    beginDocumentMount();
    for (let render = 0; render < 34; render++) {
      internals.redrawFromSource();
    }

    expect(rerender).not.toHaveBeenCalled();

    endDocumentMount();

    expect(rerender).toHaveBeenCalledTimes(1);
    expect(rebuildTabs).toHaveBeenCalledTimes(1);
    expect(rerender).toHaveBeenCalledWith({ keepDrawer: true });
  });

  it('redessine tout de suite hors montage, sans attendre une frame', () => {
    // Différer d’une frame laissait à l’écran le bandeau « source supprimée »
    // alors que la source était revenue d’un undo.
    const { internals, rerender } = standUp();

    internals.redrawFromSource();

    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it('redessine de nouveau pour un montage suivant', () => {
    const { internals, rerender } = standUp();

    beginDocumentMount();
    internals.redrawFromSource();
    endDocumentMount();
    beginDocumentMount();
    internals.redrawFromSource();
    endDocumentMount();

    expect(rerender).toHaveBeenCalledTimes(2);
  });

  it('ne redessine pas un outil détruit pendant le montage', () => {
    const { internals, rerender } = standUp();

    beginDocumentMount();
    internals.redrawFromSource();
    internals.destroyed = true;
    endDocumentMount();

    expect(rerender).not.toHaveBeenCalled();
  });
});
