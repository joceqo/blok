import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginViewportPass, claimEagerRoot, isAsleep, resetViewportRender, sleepBlock, sleepingBlocks, wakeBlock } from '../../../../src/components/utils/viewport-render';

afterEach(() => {
  resetViewportRender();
  vi.restoreAllMocks();
});

/**
 * A 870-block page mounts 24 root blocks, and only the first one starts inside
 * the first screen — the other 23 carry 846 descendants nobody is looking at.
 * Mounting them all is what makes the tab freeze for seconds.
 */
describe('rendu au viewport', () => {
  it('monte tout de suite les premières racines, endort les suivantes', () => {
    beginViewportPass(2);

    expect(claimEagerRoot()).toBe(true);
    expect(claimEagerRoot()).toBe(true);
    expect(claimEagerRoot()).toBe(false);
    expect(claimEagerRoot()).toBe(false);
  });

  it('monte tout quand aucune passe n’est ouverte', () => {
    // Hors chargement — une insertion, un collage — rien ne doit dormir.
    expect(claimEagerRoot()).toBe(true);
    expect(claimEagerRoot()).toBe(true);
  });

  it('repart à zéro à chaque passe', () => {
    beginViewportPass(1);
    claimEagerRoot();

    expect(claimEagerRoot()).toBe(false);

    beginViewportPass(1);

    expect(claimEagerRoot()).toBe(true);
  });

  it('retient qui dort, et l’oublie au réveil', () => {
    sleepBlock('b1');

    expect(isAsleep('b1')).toBe(true);
    expect([...sleepingBlocks()]).toEqual(['b1']);

    wakeBlock('b1');

    expect(isAsleep('b1')).toBe(false);
    expect([...sleepingBlocks()]).toEqual([]);
  });

  it('ne dit endormi que ce qui l’est', () => {
    expect(isAsleep('jamais-vu')).toBe(false);
  });

  it('rend la liste des dormeurs dans l’ordre où ils se sont endormis', () => {
    // Le réveil progressif suit le document : on réveille d’abord ce qui est
    // le plus proche de ce que la personne regarde.
    sleepBlock('b3');
    sleepBlock('b1');
    sleepBlock('b2');

    expect([...sleepingBlocks()]).toEqual(['b3', 'b1', 'b2']);
  });

  it('ne compte pas deux fois un bloc endormi deux fois', () => {
    sleepBlock('b1');
    sleepBlock('b1');

    expect([...sleepingBlocks()]).toEqual(['b1']);
  });
});
