import type { CloudClient } from './cloud/client';
import { createCalendarStore, type CalendarStore } from './calendar-store';
import { peekFile, type WorkspaceIndex } from './storage';
import { listWorkspaces, type WorkspaceRef } from './workspace-registry';

export interface CalendarWorkspaceEntry {
  id: string;
  name: string;
  ref: WorkspaceRef;
  color: string;
  connected: boolean;
  visible: boolean;
  canEdit: boolean;
  store: CalendarStore;
}

export interface CalendarWorkspaces {
  activeId: string;
  entries(): CalendarWorkspaceEntry[];
  unavailable?(): WorkspaceRef[];
  refresh(onAccountReady?: () => void): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  setVisible(id: string, visible: boolean): Promise<void>;
  pages(id: string): Promise<Array<{id: string; title: string}>>;
}

const colors = ['#49ca81', '#9950ff', '#32a5e5', '#fe7132', '#ee000e'];
export function workspaceColors(ids: Iterable<string>, connected: (id: string) => boolean): Map<string,string> {
  const assigned = new Map<string,string>();
  const used = new Set<number>();
  // Assign connected workspaces first. Membership ordering and display names can differ between devices.
  const sorted = [...ids].sort();
  for (const id of [...sorted.filter(connected), ...sorted.filter(id => !connected(id))]) {
    if (used.size === colors.length) used.clear();
    let hash = 0;
    for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    let slot = hash % colors.length;
    while (used.has(slot)) slot = (slot + 1) % colors.length;
    used.add(slot);
    assigned.set(id, colors[slot]!);
  }
  return assigned;
}

type Preferences = { connected: string[]; hidden: string[] };
const validIds = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
const unavailable = () => new Error('Cet espace n’est plus connecté au calendrier.');

export function createCalendarWorkspaces(current: WorkspaceRef, active = true, client?: CloudClient): CalendarWorkspaces {
  const account = current.kind === 'local' ? ['disk'] : [current.server, current.accountId];
  const preferenceKey = 'blok:calendar:workspaces:v1:' + JSON.stringify(account);
  let preferences: Preferences = {connected: [], hidden: []};
  let refs = new Map<string, WorkspaceRef>(current.kind === 'local' ? [[current.id, current]] : []);
  const stores = new Map<string, CalendarStore>();
  let generation = 0;
  let serverPreferences = false;
  let pending = Promise.resolve();
  let changes = 0;

  function readPreferences(): Preferences {
    try {
      const raw = localStorage.getItem(preferenceKey);
      if (raw) {
        const data = JSON.parse(raw);
        return {connected: validIds(data.connected), hidden: validIds(data.hidden)};
      }
    } catch { /* Private browsing can make local storage unavailable. */ }
    return preferences;
  }
  function update(connected: string[], hidden: string[]) {
    preferences = {connected: [...new Set(connected)], hidden: [...new Set(hidden)]};
    try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* Retain this session's preferences. */ }
  }
  preferences = readPreferences();

  const connected = (id: string) => refs.has(id) && ((active && current.id === id) || preferences.connected.includes(id));
  function requireRef(id: string, write = false): WorkspaceRef {
    const ref = refs.get(id);
    if (!ref || !connected(id)) throw unavailable();
    if (write && ref.kind === 'remote' && ref.role === 'viewer') throw new Error('Cet espace est en lecture seule.');
    return ref;
  }

  function storeFor(ref: WorkspaceRef): CalendarStore {
    const key = JSON.stringify([ref.id, ref.kind === 'remote' ? ref.workspaceId : '']);
    const cached = stores.get(key);
    if (cached) return cached;
    const underlying = createCalendarStore(ref, client);
    function check(write = false) {
      const latest = requireRef(ref.id, write);
      if (latest.kind === 'remote' && ref.kind === 'remote' && latest.workspaceId !== ref.workspaceId) throw unavailable();
    }
    const store: CalendarStore = {
      remote: underlying.remote,
      async list(from, to) { check(); const events = await underlying.list(from, to); check(); return events; },
      async save(event) { check(true); await underlying.save(event); },
      async remove(event) { check(true); await underlying.remove(event); },
    };
    stores.set(key, store);
    return store;
  }

  function change(id: string, patch: {connected?: boolean; visible?: boolean}): Promise<void> {
    const ref = refs.get(id);
    if (!ref) return Promise.reject(unavailable());
    ++changes;
    const apply = async () => {
      if (!refs.has(id)) throw unavailable();
      if (serverPreferences && ref.kind === 'remote') {
        const {client, base} = storeFor(ref).remote!;
        await client.request(base + '/preferences', {method:'PATCH', body:JSON.stringify({accountId:ref.accountId,...patch})});
      }
      const saved = serverPreferences ? preferences : readPreferences();
      const connected = new Set(saved.connected), hidden = new Set(saved.hidden);
      if (patch.connected === true) connected.add(id);
      if (patch.connected === false) connected.delete(id);
      if (patch.visible === false) hidden.add(id);
      if (patch.visible === true) hidden.delete(id);
      update([...connected], [...hidden]);
    };
    const result = pending.then(apply);
    pending = result.catch(() => {});
    return result;
  }

  return {
    activeId: current.id,
    entries() {
      const assigned = workspaceColors(refs.keys(), connected);
      return Array.from(refs.values(), ref => ({
        id: ref.id, name: ref.name, ref, color: assigned.get(ref.id)!, connected: connected(ref.id),
        visible: connected(ref.id) && !preferences.hidden.includes(ref.id),
        canEdit: ref.kind === 'local' || ref.role !== 'viewer', store: storeFor(ref),
      }));
    },
    async refresh() {
      const request = ++generation;
      let available: WorkspaceRef[];
      let saved: Preferences;
      await pending;
      const before = changes;
      if (current.kind === 'remote') {
        try {
          const session = await storeFor(current).remote!.client.session(AbortSignal.timeout(8000));
          if (request !== generation) return;
          if (session.user.id !== current.accountId) throw new Error('Le compte de cet agenda a changé. Rouvrez votre espace.');
          serverPreferences = Array.isArray(session.calendarWorkspaces);
          saved = session.calendarWorkspaces ? {
            connected: session.calendarWorkspaces.filter(p => p.connected).map(p => p.id),
            hidden: session.calendarWorkspaces.filter(p => !p.visible).map(p => p.id),
          } : readPreferences();
          available = session.workspaces.map(w => ({...current, id:w.id, workspaceId:w.slug, name:w.name, role:w.role}));
        } catch (error) {
          if (request !== generation) return;
          refs.clear();
          throw error;
        }
      } else {
        saved = readPreferences();
        available = [current, ...listWorkspaces().filter(ref => ref.kind === 'local' && ref.id !== current.id)];
      }
      refs = new Map(available.map(ref => [ref.id, ref]));
      if (changes === before) update(saved.connected.filter(id => refs.has(id)), saved.hidden.filter(id => refs.has(id)));
    },
    connect: id => change(id, {connected:true, visible:true}),
    disconnect: id => active && id === current.id ? Promise.resolve() : change(id, {connected:false, visible:true}),
    setVisible(id, visible) {
      if (!connected(id)) return Promise.reject(unavailable());
      return change(id, {visible});
    },
    async pages(id) {
      const ref = requireRef(id);
      let pages: WorkspaceIndex['pages'];
      if (ref.kind === 'remote') {
        const client = storeFor(ref).remote!.client;
        const index = await client.request<Pick<WorkspaceIndex, 'pages'>>('/api/workspaces/' + encodeURIComponent(ref.workspaceId) + '/index');
        pages = index.pages;
      } else {
        // Browsing a calendar must not initialise or repair an unopened workspace on disk.
        const raw = await peekFile('index', ref);
        pages = raw ? JSON.parse(raw).pages ?? [] : [];
      }
      requireRef(id);
      return pages.map(({id, title}) => ({id, title}));
    },
  };
}
