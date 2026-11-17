import { describe, expect, it, vi } from 'vitest';
import { DatabaseTool } from '../../../../src/tools/database';

/**
 * Loading a page emits DATABASE_RENDERED once per database that comes up, and
 * the mount re-emits one for the source as each block inside it activates:
 * 48 full rebuilds of a linked view on one load, 37 of them from this handler,
 * ~51 ms each. Nearly every one of them would redraw the very same thing.
 *
 * Folding that burst was tried and measured — it RAISED the count from 25 to
 * 47, because the renders are spread over seconds rather than packed into a
 * frame, so each one opened its own window instead of joining one. What works
 * is dropping the renders that would redraw the same thing.
 */
describe('redraw d’une vue liée', () => {
  /** The handler's internals, reached without standing a whole database up. */
  const standUp = (projection: () => string | null): {
    internals: { redrawFromSource(): void; sourceDigest: string | null };
    rerender: ReturnType<typeof vi.fn>;
    rebuildTabs: ReturnType<typeof vi.fn>;
  } => {
    const tool = Object.create(DatabaseTool.prototype) as DatabaseTool;
    const internals = tool as never as {
      redrawFromSource(): void;
      sourceDigest: string | null;
      element: HTMLElement | null;
      tabBar: unknown;
    };

    internals.sourceDigest = null;
    internals.element = document.createElement('div');
    internals.tabBar = {};

    const rerender = vi.fn();
    const rebuildTabs = vi.fn();

    Object.assign(internals, { rerenderView: rerender, rebuildTabBar: rebuildTabs, sourceProjection: projection });

    return { internals, rerender, rebuildTabs };
  };

  it('ne redessine pas quand la source lue est identique', () => {
    const { internals, rerender, rebuildTabs } = standUp(() => 'rows:3');

    for (let render = 0; render < 20; render++) {
      internals.redrawFromSource();
    }

    expect(rerender).toHaveBeenCalledTimes(1);
    expect(rebuildTabs).toHaveBeenCalledTimes(1);
    expect(rerender).toHaveBeenCalledWith({ keepDrawer: true });
  });

  it('redessine tout de suite, sans attendre une frame', () => {
    // Différer d’une frame laissait à l’écran le bandeau « source supprimée »
    // alors que la source était revenue.
    const { internals, rerender } = standUp(() => 'rows:3');

    internals.redrawFromSource();

    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it('redessine quand la source a réellement changé', () => {
    let rows = 3;
    const { internals, rerender } = standUp(() => `rows:${rows}`);

    internals.redrawFromSource();
    rows = 4;
    internals.redrawFromSource();

    expect(rerender).toHaveBeenCalledTimes(2);
  });

  it('redessine toujours quand la source est illisible', () => {
    // null veut dire « je n’ai pas pu lire », jamais « rien n’a changé » :
    // confondre les deux fait disparaître une mise à jour, pas une lenteur.
    const { internals, rerender } = standUp(() => null);

    internals.redrawFromSource();
    internals.redrawFromSource();

    expect(rerender).toHaveBeenCalledTimes(2);
  });

  it('redessine de nouveau après un redraw venu d’ailleurs', () => {
    // Une autre voie a redessiné la vue entre-temps : l’empreinte retenue ne
    // décrit plus ce qui est à l’écran, donc elle ne peut plus rien éliminer.
    const { internals, rerender } = standUp(() => 'rows:3');

    internals.redrawFromSource();
    internals.sourceDigest = null;
    internals.redrawFromSource();

    expect(rerender).toHaveBeenCalledTimes(2);
  });

  it('ne retient rien d’un redraw qui n’avait rien à dessiner', () => {
    // Le tout premier rendu arrive avant que la vue existe : rien n’est
    // dessiné, donc rien ne peut être éliminé contre lui.
    const { internals, rerender } = standUp(() => 'rows:3');

    internals.element = null;
    internals.redrawFromSource();
    internals.element = document.createElement('div');
    internals.redrawFromSource();

    expect(rerender).toHaveBeenCalledTimes(2);
  });
});
