import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginViewportPass, claimEagerRoot, isAsleep, observeSleepers, resetViewportRender, sleepBlock, sleepingBlocks, wakeBlock } from '../../../../src/components/utils/viewport-render';

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

describe('réveil à l’approche de l’écran', () => {
  class FakeObserver {
    public static last: FakeObserver | undefined;
    public readonly observed: Element[] = [];
    public readonly unobserved: Element[] = [];
    public disconnected = false;
    public constructor(private readonly handler: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void, public readonly options?: unknown) {
      FakeObserver.last = this;
    }
    public observe(element: Element): void { this.observed.push(element); }
    public unobserve(element: Element): void { this.unobserved.push(element); }
    public disconnect(): void { this.disconnected = true; }
    public fire(target: Element, isIntersecting = true): void { this.handler([{ target, isIntersecting }]); }
  }

  const holderFor = (id: string): HTMLElement => {
    const holder = document.createElement('div');

    holder.setAttribute('data-blok-id', id);
    document.body.append(holder);

    return holder;
  };

  afterEach(() => {
    document.body.replaceChildren();
    FakeObserver.last = undefined;
  });

  it('ne réveille un dormeur que lorsqu’il approche de l’écran', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const woken: string[] = [];
    const holder = holderFor('b1');

    sleepBlock('b1');
    observeSleepers([{ id: 'b1', holder }], id => woken.push(id));

    expect(woken).toEqual([]);

    FakeObserver.last?.fire(holder);

    expect(woken).toEqual(['b1']);
    expect(isAsleep('b1')).toBe(false);
  });

  it('ignore une entrée qui sort de l’écran', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const woken: string[] = [];
    const holder = holderFor('b1');

    sleepBlock('b1');
    observeSleepers([{ id: 'b1', holder }], id => woken.push(id));
    FakeObserver.last?.fire(holder, false);

    expect(woken).toEqual([]);
    expect(isAsleep('b1')).toBe(true);
  });

  it('cesse d’observer un dormeur réveillé', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const holder = holderFor('b1');

    sleepBlock('b1');
    observeSleepers([{ id: 'b1', holder }], () => undefined);
    FakeObserver.last?.fire(holder);
    FakeObserver.last?.fire(holder);

    expect(FakeObserver.last?.unobserved).toHaveLength(1);
  });

  it('réveille tout de suite quand le navigateur n’observe pas', () => {
    // Sans IntersectionObserver, rien ne doit rester invisible pour toujours.
    vi.stubGlobal('IntersectionObserver', undefined);
    const woken: string[] = [];

    sleepBlock('b1');
    observeSleepers([{ id: 'b1', holder: holderFor('b1') }], id => woken.push(id));

    expect(woken).toEqual(['b1']);
  });

  it('regarde loin devant l’écran, pour que rien n’apparaisse en retard', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);

    sleepBlock('b1');
    observeSleepers([{ id: 'b1', holder: holderFor('b1') }], () => undefined);

    const margin = (FakeObserver.last?.options as { rootMargin?: string } | undefined)?.rootMargin ?? '';

    expect(margin).toMatch(/\d+px/);
  });
});
