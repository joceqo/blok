// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { regroupedViews } from '../../../../src/shared/database/view-changes';

import type { DatabaseViewConfig, PropertyDefinition } from '../../../../types';

const board = (extra: Partial<DatabaseViewConfig> = {}): DatabaseViewConfig =>
  ({ id: 'v', name: 'Board', type: 'board', position: 'a0', sorts: [], filters: [], visibleProperties: [], ...extra } as DatabaseViewConfig);
const prop = (id: string, type: string): PropertyDefinition => ({ id, name: id, type, position: `a${id}` } as PropertyDefinition);

describe('regroupedViews', () => {
  it('prefers a select-like property, as a new board does', () => {
    const views = regroupedViews([board({ groupBy: 'gone' })], [prop('t', 'title'), prop('when', 'date'), prop('state', 'status')], 'gone');

    expect(views?.[0].groupBy).toBe('state');
  });

  it('takes any groupable property when no select-like one is left', () => {
    const views = regroupedViews([board({ groupBy: 'gone' })], [prop('t', 'title'), prop('when', 'date')], 'gone');

    expect(views?.[0].groupBy).toBe('when');
  });

  it('never falls back onto the title', () => {
    const views = regroupedViews([board({ groupBy: 'gone' })], [prop('t', 'title'), prop('shot', 'files')], 'gone');

    expect(views?.[0]).not.toHaveProperty('groupBy');
  });

  it('leaves the settings behind, since they described the old grouping', () => {
    const views = regroupedViews([board({ groupBy: 'gone', groupSettings: { hideEmptyGroups: true } })], [prop('t', 'title'), prop('state', 'select')], 'gone');

    expect(views?.[0].groupBy).toBe('state');
    expect(views?.[0]).not.toHaveProperty('groupSettings');
  });

  it('keeps the settings when only the sub-group went', () => {
    const views = regroupedViews([board({ groupBy: 'state', groupSettings: { hideEmptyGroups: true }, subGroupBy: 'gone' })], [prop('t', 'title'), prop('state', 'select')], 'gone');

    expect(views?.[0].groupBy).toBe('state');
    expect(views?.[0].groupSettings).toEqual({ hideEmptyGroups: true });
    expect(views?.[0]).not.toHaveProperty('subGroupBy');
  });

  it('says nothing changed when no view named the property', () => {
    expect(regroupedViews([board({ groupBy: 'state' })], [prop('t', 'title'), prop('state', 'select')], 'gone')).toBeUndefined();
  });

  it('keeps every other field of the view', () => {
    const views = regroupedViews([board({ groupBy: 'gone', name: 'Par état', visibleProperties: ['t'] })], [prop('t', 'title'), prop('state', 'select')], 'gone');

    expect(views?.[0].name).toBe('Par état');
    expect(views?.[0].visibleProperties).toEqual(['t']);
    expect(views?.[0].type).toBe('board');
  });
});
