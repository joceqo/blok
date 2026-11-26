import { IconChevronRight } from '../../src/components/icons';
import { mountCalendarSources } from './calendar-sources';
import type { CalendarStore, CalendarEvent } from './calendar-store';
import type { CalendarWorkspaceEntry, CalendarWorkspaces } from './calendar-workspaces';
import { el } from './ui/dom';

type Layer = ReturnType<typeof mountCalendarSources>;
export interface CalendarItem { event: CalendarEvent; owner?: CalendarWorkspaceEntry }

export function mountWorkspaceRail(host: HTMLElement, store: CalendarStore, spaces: CalendarWorkspaces | undefined, changed: () => void) {
  const layers = new Map<string, {section: HTMLElement; layer: Layer; store:CalendarStore}>();
  const legacy = spaces ? undefined : mountCalendarSources(host, store, changed);
  const groups = el('div', {className:'cal-space-groups'});
  const status = el('small', {attrs:{role:'status'}});
  let destroyed = false;
  let refreshing = false, changing = false;
  if (spaces) host.append(groups, status);

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
      if (layers.has(entry.id)) continue;
      const section = el('section', {className:'cal-space-group'});
      section.dataset.workspaceId = entry.id;
      const details = el('div', {className:'cal-space-sources'});
      const controls = el('div', {className:'cal-space-head'});
      const button = el('button', {attrs:{type:'button','aria-label':'Sources de ' + entry.name, 'aria-expanded':'false'}});
      button.innerHTML = IconChevronRight; button.append(document.createTextNode(entry.name)); button.title = 'Sources de ' + entry.name;
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
      layers.set(entry.id, {section, layer, store:entry.store});
    }
  }
  async function refresh() {
    if (!spaces || destroyed || refreshing || changing || document.visibilityState === 'hidden') return;
    refreshing = true;
    try {
      await spaces.refresh(() => { if (!destroyed) { render(); changed(); } });
      status.textContent = '';
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
    /** Every connected account's Google calendars, tagged with their workspace. */
    googleSources() {
      if (!spaces) return (legacy?.sources() ?? []).map(source => ({...source, workspaceId: ''}));
      render();
      return [...layers].flatMap(([workspaceId, {layer}]) => layer.sources().map(source => ({...source, workspaceId})));
    },
    setSourceVisible(workspaceId: string, sourceKey: string, visible: boolean) {
      (workspaceId ? layers.get(workspaceId)?.layer : legacy)?.setVisible(sourceKey, visible);
    },
    openSources(id: string) {
      render();
      const section = layers.get(id)?.section;
      section?.closest('details')?.setAttribute('open', '');
      const button = section?.querySelector<HTMLButtonElement>('button[aria-expanded]');
      if (button?.getAttribute('aria-expanded') === 'false') button.click();
      button?.focus();
    },
    async list(from: string, to: string): Promise<{items: CalendarItem[]; failed: string[]}> {
      if (!spaces && legacy) {
        const [own, external] = await Promise.all([legacy.workspaceVisible() ? store.list(from,to) : [], legacy.list(from,to)]);
        return {items:[...own,...external].map(event=>({event})), failed:[]};
      }
      render();
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
