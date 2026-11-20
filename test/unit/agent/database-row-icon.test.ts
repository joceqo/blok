// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { dataOf, errorOf, property, row, run, seedOf, SESSIONS } from './database-seed';

import type { OutputData } from '../../../types';

const sprints = (): OutputData => seedOf([{
  id: 'S',
  schema: [property('t', 'title')],
  rows: [row('r1', { t: 'Sprint #1' }), row('r2', { t: 'Sprint #2' })],
}]);

/**
 * A row carries an icon and a cover beside its properties, and the editor lets
 * a person set both. No command did: setRowValues writes properties only, so
 * copying a database left every row bare and the only way through was
 * block.update, which writes past the tool instead of asking it.
 */
describe.each(SESSIONS)('database.setRowIcon (%s session)', (_label, open) => {
  it('sets a row icon, and clears it with null', async () => {
    const session = open(sprints());

    expect(errorOf(await run(session, 'database.setRowIcon', { id: 'S', rowId: 'r1', icon: '🏁' }))).toBeUndefined();
    expect((await dataOf(session, 'r1'))?.icon).toBe('🏁');

    expect(errorOf(await run(session, 'database.setRowIcon', { id: 'S', rowId: 'r1', icon: null }))).toBeUndefined();
    expect((await dataOf(session, 'r1'))?.icon).toBeUndefined();
  });

  it('sets a cover and its position, and leaves the icon alone', async () => {
    const session = open(sprints());

    await run(session, 'database.setRowIcon', { id: 'S', rowId: 'r2', icon: '🏃' });
    expect(errorOf(await run(session, 'database.setRowIcon', { id: 'S', rowId: 'r2', cover: 'https://example.test/c.png', coverPosition: 30 }))).toBeUndefined();

    const data = await dataOf(session, 'r2');

    expect(data?.cover).toBe('https://example.test/c.png');
    expect(data?.coverPosition).toBe(30);
    expect(data?.icon).toBe('🏃');
  });

  it('refuses a block that is not a row of this database', async () => {
    const session = open(sprints());

    expect(errorOf(await run(session, 'database.setRowIcon', { id: 'S', rowId: 'S', icon: '🏁' }))?.code).toBe('PRECONDITION_FAILED');
  });
});
