<<<<<<< HEAD
import { workspaceKey, type WorkspaceRef } from './workspace-registry';

export function navigationRecents(ref: WorkspaceRef) {
  const key = `blok:navigation:recents:${workspaceKey(ref)}`;
  const visitsKey = `blok:navigation:visits:${workspaceKey(ref)}`;
  let ids: string[] = [];
  let visits = new Map<string, number>();
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) ids = [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, 50);
    const history: unknown = JSON.parse(localStorage.getItem(visitsKey) ?? '[]');
    if (Array.isArray(history)) {
      for (const entry of history.slice(-50)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1])) visits.set(entry[0], entry[1]);
      }
    }
  } catch { /* Keep navigation usable without storage. */ }
  return {
    get ids(): string[] { return [...ids]; },
    visitedAt: (id: string): number | undefined => visits.get(id),
    visit(id: string): void {
      visits.delete(id);
      visits.set(id, Date.now());
      if (visits.size > 50) visits = new Map([...visits].slice(-50));
      try { localStorage.setItem(visitsKey, JSON.stringify([...visits])); } catch { /* Session only. */ }
    },
    save(next: string[]): void {
      ids = next.slice(0, 50);
      try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* Session only. */ }
    },
  };
}

/** Personal navigation only: never writes shared document metadata. */
export function navigationFavorites(ref: WorkspaceRef): { has(id: string): boolean; set(id: string, favorite: boolean): void } {
  const key = `blok:navigation:favorites:${workspaceKey(ref)}`;
  let ids = new Set<string>();
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) ids = new Set(value.filter((id): id is string => typeof id === 'string'));
  } catch { /* Storage can be unavailable in a private session. */ }
  return {
    has: (id) => ids.has(id),
    set(id, favorite) {
      if (favorite) ids.add(id); else ids.delete(id);
      try { localStorage.setItem(key, JSON.stringify([...ids])); } catch { /* Keep this session usable. */ }
    },
  };
}
||||||| f8ef3c6b39
=======
import { workspaceKey, type WorkspaceRef } from './workspace-registry';

export function navigationRecents(ref: WorkspaceRef): { ids: string[]; save(ids: string[]): void } {
  const key = `blok:navigation:recents:${workspaceKey(ref)}`;
  let ids: string[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) ids = [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, 50);
  } catch { /* Keep navigation usable without storage. */ }
  return { ids, save(next) { try { localStorage.setItem(key, JSON.stringify(next.slice(0, 50))); } catch { /* Session only. */ } } };
}

/** Personal navigation only: never writes shared document metadata. */
export function navigationFavorites(ref: WorkspaceRef): { has(id: string): boolean; set(id: string, favorite: boolean): void } {
  const key = `blok:navigation:favorites:${workspaceKey(ref)}`;
  let ids = new Set<string>();
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) ids = new Set(value.filter((id): id is string => typeof id === 'string'));
  } catch { /* Storage can be unavailable in a private session. */ }
  return {
    has: (id) => ids.has(id),
    set(id, favorite) {
      if (favorite) ids.add(id); else ids.delete(id);
      try { localStorage.setItem(key, JSON.stringify([...ids])); } catch { /* Keep this session usable. */ }
    },
  };
}
>>>>>>> origin/fix/self-host-review
