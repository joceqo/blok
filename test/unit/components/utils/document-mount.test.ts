import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginDocumentMount, endDocumentMount, isDocumentMounting, onDocumentMounted } from '../../../../src/components/utils/document-mount';

afterEach(() => {
  // A test that threw mid-mount must not leave the next one inside it.
  while (isDocumentMounting()) {
    endDocumentMount();
  }
  vi.restoreAllMocks();
});

describe('montage du document', () => {
  it('ne se dit pas en cours au repos', () => {
    expect(isDocumentMounting()).toBe(false);
  });

  it('se dit en cours entre le début et la fin', () => {
    beginDocumentMount();

    expect(isDocumentMounting()).toBe(true);

    endDocumentMount();

    expect(isDocumentMounting()).toBe(false);
  });

  it('attend la fin du montage le plus extérieur', () => {
    // Un lot peut en déclencher un autre ; le travail différé n'est bon à
    // reprendre qu'une fois le dernier terminé.
    const done = vi.fn();

    beginDocumentMount();
    beginDocumentMount();
    onDocumentMounted(done);
    endDocumentMount();

    expect(done).not.toHaveBeenCalled();

    endDocumentMount();

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('rappelle chaque abonné une seule fois', () => {
    const first = vi.fn();
    const second = vi.fn();

    beginDocumentMount();
    onDocumentMounted(first);
    onDocumentMounted(second);
    endDocumentMount();
    beginDocumentMount();
    endDocumentMount();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('rappelle tout de suite quand aucun montage n’est en cours', () => {
    // Sinon un redraw demandé hors montage attendrait un montage qui ne
    // viendra jamais, et la vue resterait périmée.
    const done = vi.fn();

    onDocumentMounted(done);

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('laisse un abonné en relancer un autre sans le perdre', () => {
    const later = vi.fn();

    beginDocumentMount();
    onDocumentMounted(() => { onDocumentMounted(later); });
    endDocumentMount();

    expect(later).toHaveBeenCalledTimes(1);
  });

  it('ne retient pas un abonné qu’un autre a fait échouer', () => {
    const second = vi.fn();

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    beginDocumentMount();
    onDocumentMounted(() => { throw new Error('boom'); });
    onDocumentMounted(second);

    expect(() => { endDocumentMount(); }).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ne descend pas sous zéro si la fin est appelée en trop', () => {
    endDocumentMount();

    expect(isDocumentMounting()).toBe(false);
  });
});
