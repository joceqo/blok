// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataOf, property, run, seedOf, SESSIONS } from './database-seed';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const viewOf = async (session: Parameters<typeof dataOf>[0]): Promise<Record<string, unknown>> =>
  ((await dataOf(session, 'A'))?.views as Array<Record<string, unknown>>)[0];

// A board groups by a property. Delete that property and nothing moved the
// grouping, so every card fell into the one nameless group — the view kept
// pointing at an id the schema no longer had. Seen for real: a database built
// by an agent, its template Status dropped for a Statut of its own, every row
// in "Sans". The editor's own delete had the same hole.
describe.each(SESSIONS)('a view regroups when its grouping property goes (%s session)', (_label, open) => {
  const seed = (extra: Array<Record<string, unknown>> = []) => seedOf([{
    id: 'A',
    schema: [property('t', 'title'), property('status', 'select'), ...extra],
    // A real view carries these; the seed's minimal one does not, and any
    // rewrite of views is validated in full.
    view: { type: 'board', groupBy: 'status', sorts: [], filters: [], visibleProperties: ['t', 'status'] },
    rows: [],
  }]);

  it('falls back to another property it can group by', async () => {
    const session = open(seed([property('etat', 'select')]));

    await run(session, 'database.deleteProperty', { id: 'A', propertyId: 'status' });
    expect((await viewOf(session)).groupBy).toBe('etat');
    await session.close();
  });

  it('drops the grouping when nothing else can carry it', async () => {
    const session = open(seed([property('piece', 'files')]));

    await run(session, 'database.deleteProperty', { id: 'A', propertyId: 'status' });
    expect(await viewOf(session)).not.toHaveProperty('groupBy');
    await session.close();
  });

  it('leaves a view grouped by another property alone', async () => {
    const session = open(seed([property('etat', 'select')]));

    await run(session, 'database.deleteProperty', { id: 'A', propertyId: 'etat' });
    expect((await viewOf(session)).groupBy).toBe('status');
    await session.close();
  });

  it('puts the grouping back when the property is restored', async () => {
    const session = open(seed([property('etat', 'select')]));

    await run(session, 'database.deleteProperty', { id: 'A', propertyId: 'status' });
    await run(session, 'database.restoreProperty', { id: 'A', propertyId: 'status' });
    // The fallback stands: a restore brings the property back, not the layout
    // decisions taken without it. Changing that would surprise whoever regrouped.
    expect((await viewOf(session)).groupBy).toBe('etat');
    await session.close();
  });
});
