import { describe, expect, it, vi } from 'vitest';
import { DatabaseTool } from '../../../../src/tools/database';

/**
 * Loading a page emits DATABASE_RENDERED once per database that comes up, and
 * every one of them rebuilt a linked view from scratch: 48 full rebuilds on one
 * load, 37 of them from this handler, ~51 ms each. The rebuild does not depend
 * on which render triggered it, so a burst must collapse into one.
 */
describe('redraw d’une vue liée', () => {
  /** The handler and the rebuild, reached without standing a whole database up. */
  const internalsOf = (tool: DatabaseTool): {
    handleDatabaseRendered(payload: unknown): void;
    queueSourceRedraw(): void;
    rebuildTabBar(): void;
    rerenderView(options?: { keepDrawer?: boolean }): void;
    destroyed: boolean;
    sourceRedrawQueued: boolean;
  } => tool as never;

  it('ne reconstruit qu’une fois pour une rafale de rendus', async () => {
    const tool = Object.create(DatabaseTool.prototype) as DatabaseTool;
    const internals = internalsOf(tool);

    internals.destroyed = false;
    internals.sourceRedrawQueued = false;
    const rerender = vi.fn();
    const rebuildTabs = vi.fn();

    Object.assign(internals, { rerenderView: rerender, rebuildTabBar: rebuildTabs });

    for (let index = 0; index < 20; index++) {
      internals.queueSourceRedraw();
    }
    await Promise.resolve();

    expect(rerender).toHaveBeenCalledTimes(1);
    expect(rebuildTabs).toHaveBeenCalledTimes(1);
    expect(rerender).toHaveBeenCalledWith({ keepDrawer: true });
  });

  it('reconstruit de nouveau pour une rafale suivante', async () => {
    const tool = Object.create(DatabaseTool.prototype) as DatabaseTool;
    const internals = internalsOf(tool);

    internals.destroyed = false;
    internals.sourceRedrawQueued = false;
    const rerender = vi.fn();

    Object.assign(internals, { rerenderView: rerender, rebuildTabBar: vi.fn() });

    internals.queueSourceRedraw();
    await Promise.resolve();
    internals.queueSourceRedraw();
    await Promise.resolve();

    expect(rerender).toHaveBeenCalledTimes(2);
  });

  it('ne reconstruit pas un outil détruit entre-temps', async () => {
    const tool = Object.create(DatabaseTool.prototype) as DatabaseTool;
    const internals = internalsOf(tool);

    internals.destroyed = false;
    internals.sourceRedrawQueued = false;
    const rerender = vi.fn();

    Object.assign(internals, { rerenderView: rerender, rebuildTabBar: vi.fn() });

    internals.queueSourceRedraw();
    internals.destroyed = true;
    await Promise.resolve();

    expect(rerender).not.toHaveBeenCalled();
  });
});
