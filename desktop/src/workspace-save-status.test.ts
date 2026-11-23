import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSaveStatus } from './workspace-save-status';

const saved = { state: 'saved' as const, pendingOperations: 0, pendingBytes: 0, quarantinedOperations: 0 };
const pending = { ...saved, state: 'pending' as const, pendingOperations: 1, pendingBytes: 32 };

describe('workspace save feedback', () => {
  it('announces remote disconnection and pending edits without claiming a durable local copy', () => {
    const status = createWorkspaceSaveStatus(true, true);
    status.connection({ status: 'offline', save: pending });
    expect(status.element.textContent).toBe('Hors-ligne · non enregistré');
    expect(status.element.title).toContain('Gardez cette page ouverte');
    expect(status.element.title).not.toContain('enregistrée sur cet appareil');
    expect(status.element.getAttribute('role')).toBe('status');
    expect(status.element.getAttribute('aria-live')).toBe('polite');
  });

  it('keeps pending work visible through reconnect until the server acknowledges it', () => {
    const status = createWorkspaceSaveStatus(true, false);
    status.connection({ status: 'offline', save: pending });
    status.online(true);
    status.connection({ status: 'connected', save: pending });
    expect(status.element.textContent).toBe('Synchronisation…');
    status.connection({ status: 'connected', save: saved });
    expect(status.element.textContent).toBe('Enregistré');
    expect(status.element.hasAttribute('data-error')).toBe(false);
  });

  it('does not report unknown, unavailable or malformed save data as saved', () => {
    const status = createWorkspaceSaveStatus(true, true);
    status.connection();
    status.connection({ status: 'connected' });
    expect(status.element.textContent).toBe('Confirmation en attente');
    status.connection({ status: 'connected', save: { ...saved, state: 'unavailable' } });
    expect(status.element.textContent).toBe('Confirmation en attente');
    status.connection({ status: 'connected', save: { ...saved, pendingBytes: 1 } });
    expect(status.element.textContent).toBe('Synchronisation…');
  });

  it('keeps failed metadata unsaved when the document session reconnects', () => {
    const status = createWorkspaceSaveStatus(true, true);
    status.error(new TypeError('Load failed'));
    status.connection({ status: 'connected', save: saved });
    expect(status.element.textContent).toBe('Hors-ligne · non enregistré');
    expect(status.element.title).not.toMatch(/TypeError|Load failed/);
    status.pending(1);
    status.saved();
    expect(status.element.textContent).toBe('Synchronisation…');
    status.pending(0);
    expect(status.element.textContent).toBe('Enregistré');
  });

  it('reports an unexpected TypeError without labelling the browser offline', () => {
    const status = createWorkspaceSaveStatus(true, true);
    status.error(new TypeError('Cannot read private information'), null, 'manifest');
    expect(status.element.getAttribute('data-sync-state')).toBe('error');
    expect(status.diagnostic().failures[0]?.kind).toBe('TypeError');
    expect(JSON.stringify(status.diagnostic())).not.toContain('private information');
  });

  it('shows terminal and blocked states as errors even when the browser is offline', () => {
    const status = createWorkspaceSaveStatus(true, false);
    status.connection({ status: 'error', save: saved });
    expect(status.element.textContent).toBe('Enregistrement interrompu');
    status.connection({ status: 'connected', save: { ...saved, state: 'blocked' } });
    expect(status.element.hasAttribute('data-error')).toBe(true);
    status.connection({ status: 'connected', save: { ...saved, state: 'quarantined' } });
    expect(status.element.textContent).toBe('Enregistrement interrompu');
  });

  it('drops an old page’s pending quarantine review when navigating', async () => {
    const clearQuarantine = vi.fn();
    type Review = { through: number; entries: { reason: string; count: number }[] };
    let finish!: (value: Review) => void;
    const review = new Promise<Review>(resolve => { finish = resolve; });
    const status = createWorkspaceSaveStatus(true, true, () => ({
      inspectQuarantine: () => review, clearQuarantine,
    }));
    status.connection({ status: 'connected', save: { ...saved, state: 'quarantined', quarantinedOperations: 1 } });
    expect(status.element.textContent).toContain('1 modification refusée');
    status.element.querySelector('button')!.click();
    status.resetPage();
    finish({ through: 1, entries: [{ reason: 'read-only', count: 1 }] });
    await review;
    expect(status.element.querySelector('button')).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
    expect(clearQuarantine).not.toHaveBeenCalled();
    status.dispose();
  });

  it('tracks a failed action independently from acknowledged text, then resolves only that action', () => {
    const status = createWorkspaceSaveStatus(true, true, undefined, { pageId: () => 'page-a' });
    const requestId = 'a'.repeat(32);
    status.error(Object.assign(new Error('secret page text'), { status: 409, requestId }), null, 'move', 'page-b');
    status.connection({ status: 'connected', participants: [], reason: 'private socket detail',
      save: { ...saved, serverSequence: '42' } });
    const report = status.diagnostic();
    expect(report.pageId).toBe('page-a');
    expect(report.failures).toMatchObject([{ source: 'move', pageId: 'page-b', httpStatus: 409, requestId }]);
    expect(report.sync).toMatchObject({ state: 'saved', serverSequence: '42' });
    expect(JSON.stringify(report)).not.toMatch(/secret page text|private socket detail/);
    status.saved('move', 'page-c');
    expect(status.diagnostic().failures).toHaveLength(1);
    status.saved('move', 'page-b');
    expect(status.diagnostic().failures).toEqual([]);
    expect(status.element.getAttribute('data-sync-state')).toBe('saved');
  });

  it('preserves access refusal explanations without exposing the original error', () => {
    const status = createWorkspaceSaveStatus(true, true);
    status.error(new Error('private server details'), 'Vous n’avez plus accès à cette page.');
    status.connection({ status: 'connected', save: saved });
    expect(status.element.textContent).toBe('Accès refusé');
    expect(status.element.title).toBe('Vous n’avez plus accès à cette page.');
  });

  it('distinguishes local storage from remote sync and ignores browser network loss locally', () => {
    const status = createWorkspaceSaveStatus(false, false);
    expect(status.element.textContent).toBe('Ouverture…');
    status.ready();
    expect(status.element.textContent).toBe('Sur cet appareil');
    status.pending(1);
    expect(status.element.textContent).toBe('Enregistrement…');
    status.error(new Error('disk full'));
    status.pending(0);
    expect(status.element.textContent).toBe('Enregistrement impossible');
    status.saved();
    status.online(false);
    expect(status.element.textContent).toBe('Sur cet appareil');
  });

  it('does not carry a saved remote acknowledgement over to another page', () => {
    const status = createWorkspaceSaveStatus(true, true);
    status.connection({ status: 'connected', save: saved });
    status.resetPage();
    expect(status.element.textContent).toBe('Connexion…');
  });

  it('does not let successful metadata writes hide a failed document save', () => {
    const status = createWorkspaceSaveStatus(false, true);
    status.ready();
    status.error(new Error('disk full'), null, 'document');
    status.saved('manifest');
    expect(status.element.textContent).toBe('Enregistrement impossible');
    status.saved('document');
    expect(status.element.textContent).toBe('Sur cet appareil');
  });
});


describe('quiet workspace save indicator', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('keeps rapid edits compact without claiming they are already saved', () => {
    vi.useFakeTimers();
    const status = createWorkspaceSaveStatus(true, true);
    status.connection({status: 'connected', save: saved});
    const icon = status.element.querySelector('svg');
    expect(icon).not.toBeNull();
    for (let i = 0; i < 10; i++) {
      status.connection({status: 'connected', save: pending});
      expect(status.element.hasAttribute('data-sync-compact')).toBe(true);
      expect(status.element.getAttribute('aria-label')).toContain('Synchronisation');
      expect(status.element.getAttribute('aria-live')).toBe('off');
      vi.advanceTimersByTime(120);
      status.connection({status: 'connected', save: saved});
      vi.advanceTimersByTime(80);
      expect(status.element.hasAttribute('data-sync-busy')).toBe(false);
      expect(status.element.querySelector('svg')).toBe(icon);
    }
  });

  it('shows activity only for a sustained wait, despite repeated pending events', () => {
    vi.useFakeTimers();
    const status = createWorkspaceSaveStatus(true, true);
    status.connection({status: 'connected', save: saved});
    status.connection({status: 'connected', save: pending});
    vi.advanceTimersByTime(600);
    status.connection({status: 'connected', save: pending});
    vi.advanceTimersByTime(399);
    expect(status.element.hasAttribute('data-sync-busy')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(status.element.hasAttribute('data-sync-busy')).toBe(true);
    expect(status.element.hasAttribute('data-sync-compact')).toBe(true);
    status.connection({status: 'connected', save: saved});
    expect(status.element.hasAttribute('data-sync-busy')).toBe(false);
  });

  it('immediately exposes offline and failure text and cancels queued animation', () => {
    vi.useFakeTimers();
    const status = createWorkspaceSaveStatus(true, true);
    status.connection({status: 'connected', save: pending});
    vi.advanceTimersByTime(100);
    status.online(false);
    expect(status.element.hasAttribute('data-sync-compact')).toBe(false);
    expect(status.element.textContent).toBe('Hors-ligne · non enregistré');
    expect(status.element.getAttribute('aria-live')).toBe('polite');
    vi.advanceTimersByTime(1200);
    expect(status.element.hasAttribute('data-sync-busy')).toBe(false);
    status.error(new Error('private'), 'Accès retiré');
    expect(status.element.hasAttribute('data-sync-compact')).toBe(false);
    expect(status.element.textContent).toBe('Accès refusé');
  });

  it('cancels delayed activity on page reset and workspace disposal', () => {
    vi.useFakeTimers();
    const status = createWorkspaceSaveStatus(true, true);
    status.connection({status: 'connected', save: pending});
    vi.advanceTimersByTime(900);
    status.resetPage();
    vi.advanceTimersByTime(100);
    expect(status.element.hasAttribute('data-sync-busy')).toBe(false);
    status.dispose();
    vi.advanceTimersByTime(2000);
    expect(status.element.hasAttribute('data-sync-busy')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
