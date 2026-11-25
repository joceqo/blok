import { IconChevronRight, IconPlus } from '../../src/components/icons';
import { mountCalendarSources } from './calendar-sources';
import type { CalendarStore, CalendarEvent } from './calendar-store';
import type { CalendarWorkspaceEntry, CalendarWorkspaces } from './calendar-workspaces';
import { el } from './ui/dom';

type Layer = ReturnType<typeof mountCalendarSources>;
export interface CalendarItem { event: CalendarEvent; owner?: CalendarWorkspaceEntry }

export function mountWorkspaceRail(host: HTMLElement, store: CalendarStore, spaces: CalendarWorkspaces | undefined, changed: () => void) {
  const layers = new Map<string, {section: HTMLElement; layer: Layer; visible: HTMLInputElement; store:CalendarStore}>();
  const legacy = spaces ? undefined : mountCalendarSources(host, store, changed);
  const heading = el('h3', {text:'Mes espaces'});
  const groups = el('div', {className:'cal-space-groups'});
  const add = el('select', {attrs:{'aria-label':'Ajouter un espace'}});
  const addRow = el('label', {className:'cal-space-add'});
  const plus = el('span', {attrs:{'aria-hidden':'true'}}); plus.innerHTML = IconPlus;
  addRow.append(plus, add);
  const status = el('small', {attrs:{role:'status'}});
  let destroyed = false;
  let refreshing = false, changing = false;
  if (spaces) host.append(heading, groups, addRow, status);

  async function change(operation: () => void | Promise<void>) {
    if (changing || destroyed) return;
    changing = true;
    host.inert = true;
    try {
      await operation(); status.textContent = '';
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : 'Modification des agendas impossible.';
    } finally {
      changing = false; host.inert = false;
      if (!destroyed) { render(); changed(); }
    }
  }
  function render() {
    if (!spaces || destroyed) return;
    const entries = spaces.entries();
    const connected = entries.filter(e => e.connected);
    for (const [id, group] of layers) {
      if (!connected.some(entry => entry.id === id && entry.store === group.store)) {
        group.layer.destroy(); group.section.remove(); layers.delete(id);
      }
    }
    for (const entry of connected) {
      const previous = layers.get(entry.id);
      if (previous) {
        previous.visible.checked = entry.visible;
        previous.visible.style.setProperty('--cal-source-color', entry.color);
        continue;
      }
      const section = el('section', {className:'cal-space-group'});
      section.dataset.workspaceId = entry.id;
      const box = el('input', {attrs:{type:'checkbox'}});
      box.checked = entry.visible;
      box.style.setProperty('--cal-source-color', entry.color);
      box.onchange = () => { void change(() => spaces.setVisible(entry.id, box.checked)); };
      const label = el('label', {children:[box, el('span', {text:entry.name})]});
      const details = el('div', {className:'cal-space-sources'});
      const controls = el('div', {className:'cal-space-head', children:[label]});
      const button = el('button', {attrs:{type:'button','aria-label':'Sources de ' + entry.name, 'aria-expanded':'false'}});
      button.innerHTML = IconChevronRight; button.title = 'Sources de ' + entry.name;
      controls.append(button);
      details.hidden = true;
      button.onclick = () => { details.hidden = !details.hidden; button.setAttribute('aria-expanded', String(!details.hidden)); };
      const external = el('div', {className:'cal-sources'});
      details.append(external);
      if (entry.id !== spaces.activeId) {
        const remove = el('button', {text:'Retirer cet espace', attrs:{type:'button','aria-label':'Retirer ' + entry.name}});
        remove.onclick = () => { void change(() => spaces.disconnect(entry.id)); };
        details.append(remove);
      }
      section.append(controls, details); groups.append(section);
      const layer = mountCalendarSources(external, entry.store, changed, true);
      layers.set(entry.id, {section, layer, visible:box, store:entry.store});
    }
    const available = entries.filter(e => !e.connected);
    add.replaceChildren(new Option('Ajouter un espace', ''), ...available.map(e => new Option(e.name, e.id)));
    addRow.hidden = available.length === 0;
  }
  add.onchange = () => { if (spaces && add.value) void change(() => spaces.connect(add.value)); };
  async function refresh() {
    if (!spaces || destroyed || refreshing || changing || document.visibilityState === 'hidden') return;
    refreshing = true;
    try {
      await spaces.refresh(); status.textContent = '';
    } catch {
      if (!destroyed) {
        const retry = el('button', {text:'Réessayer', attrs:{type:'button'}});
        retry.onclick = () => { void refresh(); };
        status.replaceChildren('Espaces indisponibles. ', retry);
      }
    } finally {
      refreshing = false;
      if (!destroyed) { render(); changed(); }
    }
  }
  render();
  let timer: number | undefined;
  if (spaces) {
    void refresh(); window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    timer = window.setInterval(refresh, 60_000);
  }

  return {
    async list(from: string, to: string): Promise<{items: CalendarItem[]; failed: string[]}> {
      if (!spaces && legacy) {
        const [own, external] = await Promise.all([legacy.workspaceVisible() ? store.list(from,to) : [], legacy.list(from,to)]);
        return {items:[...own,...external].map(event=>({event})), failed:[]};
      }
      const entries = spaces!.entries().filter(e => e.connected && e.visible);
      const batches = await Promise.allSettled(entries.map(async owner => {
        const [own, external] = await Promise.all([owner.store.list(from,to), layers.get(owner.id)?.layer.list(from,to) ?? []]);
        return [...own,...external].map(event=>({event,owner}));
      }));
      const items: CalendarItem[] = [], failed: string[] = [];
      batches.forEach((batch,i) => { if (batch.status==='fulfilled') items.push(...batch.value); else failed.push(entries[i].name); });
      return {items,failed};
    },
    destroy() {
      destroyed = true; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange',refresh); window.clearInterval(timer); legacy?.destroy();
      for (const {layer} of layers.values()) layer.destroy();
    },
  };
}
