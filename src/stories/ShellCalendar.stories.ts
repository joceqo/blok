import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, fireEvent, waitFor, within } from 'storybook/test';
import { mountCalendar } from '../../desktop/src/calendar-view';
import type { CalendarEvent, CalendarStore } from '../../desktop/src/calendar-store';
import { PreviewClient, shellPreview, type ShellTheme } from './shell-story-fixtures';

type Args = { theme: ShellTheme; canEdit: boolean; layered: boolean };

const meta = {
  title: 'Shell/Calendrier',
  id: 'shell-calendrier',
  parameters: { layout: 'fullscreen' },
  args: { theme: 'light', canEdit: true, layered: false },
  argTypes: {
    theme: { name: 'Thème', control: 'inline-radio', options: ['light', 'dark'] },
    canEdit: { name: 'Modification', control: 'boolean' },
    layered: { table: { disable: true } },
  },
  render: ({theme, canEdit, layered}, {abortSignal}) => {
    const host = shellPreview(theme);
    const canvas = document.createElement('main');
    canvas.style.height = '100vh';
    canvas.style.minWidth = '0';
    host.append(canvas);
    const page = { id: 'brief', title: 'Brief produit' };
    const monday = new Date();
    monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
    const time = (day: number, hour: number, minute = 0): string => {
      const date = new Date(monday);
      date.setDate(date.getDate() + day);
      date.setHours(hour, minute, 0, 0);
      return date.toISOString();
    };
    const meeting = (id: string, title: string, day: number, start: number, end: number, pageId: string | null = null): CalendarEvent => ({
      id, title, start: time(day, Math.floor(start), Math.round(start % 1 * 60)),
      end: time(day, Math.floor(end), Math.round(end % 1 * 60)), allDay: false, revision: 1, pageId,
    });
    const events = [
      meeting('review', 'Revue produit', 0, 10, 11, page.id),
      meeting('atelier', 'Atelier de conception', 2, 14, 15.5, page.id),
    ];
    let remote: CalendarStore['remote'];
    if (layered) {
      const localDate = (offset: number) => {
        const date = new Date(time(offset, 12));
        return [date.getFullYear(), String(date.getMonth() + 1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
      };
      events.push(
        meeting('kickoff', 'Cadrage du sprint', 0, 14, 15.5),
        meeting('maquette', 'Revue des maquettes', 1, 9.5, 11, page.id),
        meeting('test', 'Tests utilisateurs', 3, 13.5, 15),
        meeting('retrospective', 'Rétrospective', 4, 15.5, 16.5),
        { id: 'sortie', title: 'Livraison du site', start: localDate(4), end: localDate(5), allDay: true, pageId: page.id, revision: 1 },
      );
      const google = [
        meeting('podcast', 'Enregistrement du podcast', 0, 11.5, 12.5),
        meeting('lunch', 'Déjeuner avec Camille', 1, 12.5, 14),
        meeting('prep', 'Préparer la présentation', 2, 9, 10.5),
        meeting('demo', 'Démo partenaire', 3, 10, 11.5),
        meeting('cafe', 'Café avec Alex', 4, 9.5, 10.5),
      ];
      const busy = [meeting('b1', '', 1, 14.5, 16), meeting('b2', '', 2, 10.5, 12), meeting('b3', '', 4, 13, 14.5)];
      let sharing = true, connected = true;
      const base = '/api/workspaces/atelier/calendar';
      const client = new PreviewClient((path, init) => {
        const url = new URL(path, 'https://preview.invalid');
        const route = url.pathname.slice(base.length);
        if (route === '/google/status') return { configured: true, connected };
        if (route === '/google/calendars') return { calendars: [{id: 'primary', title: 'Agenda personnel', color: '#8472b5', primary: true}] };
        if (route === '/google/connection' && init?.method === 'DELETE') { connected = false; return {ok:true}; }
        if (route === '/members') return { members: [{id:'lina',name:'Lina Martin'}], sharing };
        if (route === '/sharing' && init?.method === 'PUT' && typeof init.body === 'string') {
          sharing = JSON.parse(init.body).enabled === true;
          return { sharing };
        }
        if (route === '/feeds') return { feeds: [] };
        const withinRange = (e: CalendarEvent) => e.start < (url.searchParams.get('to') ?? '') && e.end > (url.searchParams.get('from') ?? '');
        if (route === '/google/events') return { events: google.filter(withinRange) };
        if (route === '/members/lina/freebusy') return { busy: busy.filter(withinRange).map(({start, end}) => ({start,end})) };
        throw new Error('Cette action ne fait pas partie de cet aperçu.');
      });
      remote = { client, base, preferenceKey: 'storybook-agendas-superposes' };
    }
    const store: CalendarStore = {
      remote,
      async list(from, to) {
        return events.filter(event => event.allDay ? event.start < to.slice(0,10) && event.end > from.slice(0,10) : event.start < to && event.end > from);
      },
      async save(event) {
        const index = events.findIndex(item => item.id === event.id);
        const saved = {...event, revision: event.revision + 1};
        if (index === -1) events.push(saved);
        else events[index] = saved;
      },
      async remove(event) {
        const index = events.findIndex(item => item.id === event.id);
        if (index >= 0) events.splice(index, 1);
      },
    };
    let calendar: ReturnType<typeof mountCalendar>;
    const showPage = () => {
      calendar.destroy();
      const heading = document.createElement('h1');
      heading.textContent = page.title;
      const back = document.createElement('button');
      back.type = 'button';
      back.textContent = 'Calendrier';
      back.addEventListener('click', showCalendar);
      canvas.replaceChildren(heading, back);
    };
    const showCalendar = () => {
      canvas.replaceChildren();
      calendar = mountCalendar(canvas, { store, pages: [page], canEdit, openPage: showPage, onClose: showPage });
    };
    showCalendar();
    abortSignal.addEventListener('abort', () => calendar.destroy(), { once: true });
    return host;
  },
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<Args>;
export const Semaine: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: 'Calendrier' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Nouvel événement' })).toBeVisible();
  },
};
export const LectureSeule: Story = {
  args: { canEdit: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: 'Calendrier' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Nouvel événement' })).toBeNull();
  },
};

export const AgendasSuperposes: Story = {
  name: 'Agendas superposés',
  args: { layered: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const view = canvas.getByRole('combobox', {name: 'Vue du calendrier'}) as HTMLSelectElement;
    if (view.value !== '7') await fireEvent.change(view, {target: {value: '7'}});
    const showFilters = canvas.queryByRole('button', {name: 'Agendas', exact: true});
    if (showFilters) await fireEvent.click(showFilters);
    const team = await canvas.findByRole('checkbox', { name: 'Lina Martin' }) as HTMLInputElement;
    if (!team.checked) await fireEvent.click(team);
    const google = await canvas.findByRole('checkbox', { name: 'Agenda personnel' }) as HTMLInputElement;
    if (google.checked) await fireEvent.click(google);
    await waitFor(() => expect(canvasElement.querySelector('[data-event-id*="podcast"]')).toBeNull());
    await fireEvent.click(google);
    await waitFor(() => expect(canvasElement.querySelector('[data-event-id*="podcast"]')).toBeInTheDocument());
  },
};
