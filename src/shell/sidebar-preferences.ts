export type SidebarSection = 'events' | 'favorites';

export function createSidebarPreferences(preferenceKey: string | undefined, hasEvents: boolean) {
  const key = preferenceKey ? 'blok:sidebar:sections:' + preferenceKey : undefined;
  const defaults = {events: true, favorites: true};
  const listeners = new Set<() => void>();

  function read(fallback: typeof defaults) {
    if (!key) return fallback;
    try {
      const data = JSON.parse(localStorage.getItem(key) || '{}');
      return {events: data?.events !== false, favorites: data?.favorites !== false};
    } catch { return fallback; }
  }

  let state = read(defaults);
  return {
    hasEvents,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(section: SidebarSection, visible: boolean) {
      state = {...read(state), [section]: visible};
      if (key) {
        try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* Retain changes for this frame. */ }
      }
      listeners.forEach(listener => listener());
    },
  };
}

export type SidebarPreferences = ReturnType<typeof createSidebarPreferences>;
