import {shellText} from './shell-i18n';
interface Actor {
  id: string;
  kind: 'agent' | 'person';
  onBehalfOf?: string;
}
interface Modification {
  id: string;
  action: 'created' | 'updated' | 'deleted';
  name?: string;
}
interface BlockChanges {
  id: string;
  properties?: { id: string; before?: unknown; after?: unknown }[];
  schema?: Modification[];
  views?: Modification[];
}
interface Change {
  sequence: number;
  actor?: string;
  actors?: Actor[];
  blocks: BlockChanges[];
}
interface ChangePage {
  changes: Change[];
  truncated: boolean;
  olderEnd?: { lineage: string; sequence: number };
}
type Request = <T>(path: string) => Promise<T>;
const actions = { created: 'création', updated: 'modification', deleted: 'suppression' };

function value(change: Record<string, unknown>, key: string) {
  if (!Object.hasOwn(change, key)) return 'absent';
  const value = change[key];
  if (value === null) return 'null';
  return typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? '');
}

function historyEntry(change: Change) {
  const row = document.createElement('li');
  const heading = document.createElement('strong');
  const people = (change.actors ?? []).map((actor) =>
    actor.kind === 'agent'
      ? 'Agent ' + actor.id + (actor.onBehalfOf ? ' pour ' + actor.onBehalfOf : '')
      : actor.id,
  );
  heading.textContent = ['Modification ' + change.sequence, people.join(', ') || change.actor]
    .filter(Boolean)
    .join(' · ');
  row.append(heading);
  const list = document.createElement('ul');
  const line = (label: string) => {
    const li = document.createElement('li');
    li.textContent = label;
    list.append(li);
  };
  for (const block of change.blocks) {
    for (const field of block.properties ?? []) {
      line(
        'Ligne ' +
          block.id +
          ' · ' +
          field.id +
          ' : ' +
          value(field, 'before') +
          ' → ' +
          value(field, 'after'),
      );
    }
    for (const property of block.schema ?? [])
      line('Propriété ' + (property.name || property.id) + ' · ' + actions[property.action]);
    for (const view of block.views ?? []) line('Vue ' + view.id + ' · ' + actions[view.action]);
  }
  if (list.childElementCount) row.append(list);
  return row;
}

export function historyChangeDetails(request: Request, lineage: string, sequence: number, since: number) {
  const details = document.createElement('details');
  details.setAttribute('data-history-details', '');
  const summary = document.createElement('summary');
  summary.textContent = shellText("Modifications de cette version");
  const rows = document.createElement('ol');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const more = document.createElement('button');
  more.type = 'button';
  more.hidden = true;
  details.append(summary, rows, status, more);
  let next: number | undefined = sequence;
  let busy = false,
    started = false;
  async function load() {
    if (busy || next === undefined) return;
    busy = true;
    started = true;
    more.hidden = true;
    status.textContent = shellText("Chargement…");
    try {
      const page: ChangePage = await request(
        '/' + encodeURIComponent(lineage) + '/' + next + '/changes?since=' + since + '&detail=properties',
      );
      if (!details.isConnected) return;
      rows.append(...page.changes.slice().reverse().map(historyEntry));
      const older = page.olderEnd;
      next =
        page.truncated &&
        older?.lineage === lineage &&
        older.sequence > since + 1 &&
        older.sequence - 1 < next
          ? older.sequence - 1
          : undefined;
      more.hidden = next === undefined;
      more.textContent = shellText("Afficher les modifications précédentes");
      status.textContent = rows.childElementCount ? '' : shellText("Aucune modification enregistrée.");
    } catch {
      if (!details.isConnected) return;
      status.textContent = shellText("Les modifications n’ont pas pu être chargées.");
      more.hidden = false;
      more.textContent = shellText("Réessayer");
    } finally {
      busy = false;
    }
  }
  details.ontoggle = () => {
    if (details.open && !started) void load();
  };
  more.onclick = () => {
    void load();
  };
  return details;
}
