import { describe, expect, it, vi } from 'vitest';
import { must } from './test-helpers';
import { createEmptyWorkspaceState } from './workspace-empty';

describe('empty remote workspace', () => {
  it('shows a clear message without creating a page automatically', () => {
    const create = vi.fn();
    const element = createEmptyWorkspaceState(false, create);
    expect(element.textContent).toContain('Cet espace est vide. Créez votre première page.');
    expect(create).not.toHaveBeenCalled();
    must(element.querySelector<HTMLButtonElement>('button')).click();
    expect(create).toHaveBeenCalledOnce();
  });

  it('explains that no page is available to a viewer without offering creation', () => {
    const create = vi.fn();
    const element = createEmptyWorkspaceState(true, create);
    expect(element.textContent).toContain('Aucune page n’est partagée avec vous pour le moment');
    expect(element.querySelector('button')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('offers three start cards and two discreet links for non-viewers', () => {
    const create = vi.fn();
    const template = vi.fn();
    const invite = vi.fn();
    const importPage = vi.fn();
    const gettingStarted = vi.fn();
    const element = createEmptyWorkspaceState(false, create, {
      onTemplate: template,
      onInvite: invite,
      onImport: importPage,
      onGettingStarted: gettingStarted,
    });
    const labels = [...element.querySelectorAll('[data-desktop-empty-card]')].map((node) => node.textContent);
    expect(labels).toEqual([
      expect.stringContaining('Créer une page'),
      expect.stringContaining('Partir d’un modèle'),
      expect.stringContaining('Inviter des personnes'),
    ]);
    const links = [...element.querySelectorAll('[data-desktop-empty-link]')].map((node) => node.textContent);
    expect(links).toEqual(['Importer', 'Premiers pas']);
    must(element.querySelector<HTMLButtonElement>('[data-desktop-empty-card="template"]')).click();
    must(element.querySelector<HTMLButtonElement>('[data-desktop-empty-card="invite"]')).click();
    must(element.querySelector<HTMLButtonElement>('[data-desktop-empty-link="import"]')).click();
    must(element.querySelector<HTMLButtonElement>('[data-desktop-empty-link="getting-started"]')).click();
    expect(template).toHaveBeenCalledOnce();
    expect(invite).toHaveBeenCalledOnce();
    expect(importPage).toHaveBeenCalledOnce();
    expect(gettingStarted).toHaveBeenCalledOnce();
  });
});

/**
 * A member who joins a workspace sees only what is shared with them. With
 * nothing shared yet, "Cet espace est vide. Créez votre première page." is
 * false — the workspace is full, they simply cannot see it. They keep every
 * way to create a page; only the sentence changes.
 */
it('says nothing is shared, without taking away the ability to create', () => {
  const element = createEmptyWorkspaceState(false, () => undefined, { nothingShared: true });
  expect(element.querySelector('[role="status"]')?.textContent).toContain('partagée');
  expect(element.querySelector('[data-desktop-empty-create]')).not.toBeNull();

  const viewer = createEmptyWorkspaceState(true, () => undefined, { nothingShared: true });
  expect(viewer.querySelector('[data-desktop-empty-create]')).toBeNull();

  const fresh = createEmptyWorkspaceState(false, () => undefined, {});
  expect(fresh.querySelector('[role="status"]')?.textContent).toContain('vide');
});
