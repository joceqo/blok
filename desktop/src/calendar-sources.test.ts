import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCalendarSources } from './calendar-sources';
import type { CalendarStore } from './calendar-store';

const calendars = [
  {id: 'jocelin.queau@nexenture.fr', title: 'jocelin.queau@nexenture.fr', color: '#9fe1e7', primary: true},
  {id: 'fr.french#holiday@group.v.calendar.google.com', title: 'Jours fériés', color: '#16a765', primary: false},
  {id: 'romain@nexenture.fr', title: 'Travail', color: '#fa573c', primary: false, busyOnly: true},
];

function storeWithGoogle() {
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('/google/status')) return {configured: true, connected: true};
    if (path.endsWith('/google/calendars')) return {calendars};
    if (path.endsWith('/members')) return {members: [], sharing: false};
    if (path.endsWith('/feeds')) return {feeds: []};
    return {};
  });
  return {
    remote: {client: {request}, base: '/api/workspaces/local/calendar', preferenceKey: 'test-key'},
  } as unknown as CalendarStore;
}

describe('calendar sources — Google account model', () => {
  beforeEach(() => localStorage.clear());

  it('exposes every calendar of the account, shared ones included, under the account address', async () => {
    const panel = mountCalendarSources(document.createElement('div'), storeWithGoogle(), () => {});
    await vi.waitFor(() => expect(panel.sources()).toHaveLength(3));
    // The primary calendar's id IS the account address: no extra server call.
    expect(panel.sources().every(source => source.account === 'jocelin.queau@nexenture.fr')).toBe(true);
    expect(panel.sources().map(source => source.label)).toEqual([
      'jocelin.queau@nexenture.fr', 'Jours fériés', 'Travail · Disponibilités',
    ]);
    // Only the primary calendar shows by default — which is why a busy primary
    // calendar makes a freshly connected account look empty.
    expect(panel.sources().map(source => source.visible)).toEqual([true, false, false]);
    expect(panel.sources()[1]!.color).toBe('#16a765');
    panel.destroy();
  });

  it('shows and hides a shared calendar, and reports the change', async () => {
    const changed = vi.fn();
    const panel = mountCalendarSources(document.createElement('div'), storeWithGoogle(), changed);
    await vi.waitFor(() => expect(panel.sources()).toHaveLength(3));
    const shared = panel.sources().find(source => source.label.startsWith('Travail'))!;
    panel.setVisible(shared.key, true);
    expect(panel.sources().find(source => source.key === shared.key)?.visible).toBe(true);
    expect(changed).toHaveBeenCalled();
    panel.setVisible(shared.key, false);
    expect(panel.sources().find(source => source.key === shared.key)?.visible).toBe(false);
    panel.destroy();
  });
});
