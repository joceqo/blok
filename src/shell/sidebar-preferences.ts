export const sidebarPromptLabels = {
  customize: 'Personnaliser la barre latérale',
  invite: 'Inviter des membres',
  download: 'Télécharger la version desktop',
} as const;
export type SidebarPrompt = keyof typeof sidebarPromptLabels;
export type SidebarSection = 'events' | 'favorites' | SidebarPrompt;

export function createSidebarPreferences(preferenceKey: string | undefined, hasEvents: boolean, prompts: readonly SidebarPrompt[] = []) {
  const key = preferenceKey ? 'blok:sidebar:sections:' + preferenceKey : undefined;
  const defaults = {events: true, favorites: true, customize: true, invite: true, download: true};
  const listeners = new Set<() => void>();

  function read(fallback: typeof defaults) {
    if (!key) return fallback;
    try {
      const data: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (!data || typeof data !== 'object') return fallback;
      const state = {...defaults};
      for (const section of Object.keys(defaults) as SidebarSection[]) {
        state[section] = Reflect.get(data, section) !== false;
      }
      return state;
    } catch { return fallback; }
  }

  let state = read(defaults);
  return {
    hasEvents,
    prompts,
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
