import { describe, expect, it } from 'vitest';
import { quickActions } from '../../../src/shell/agent-chat/quick-actions';

describe('assistant quick actions', () => {
  it('offers the page it is on, when it is on one', () => {
    const asked = quickActions(true).map(action => action.text);
    expect(asked).toContain('Résumer cette page');
    expect(asked.every(text => text.length > 0)).toBe(true);
  });

  it('never asks about "this page" when there is no page', () => {
    // The full-screen assistant opens on no page at all, where every one of
    // these used to ask the model about nothing.
    const asked = quickActions(false).map(action => action.text);
    expect(asked).not.toHaveLength(0);
    expect(asked.some(text => /cette page/i.test(text))).toBe(false);
  });

  it('gives each action its own id, so none overwrites another', () => {
    for (const hasPage of [true, false]) {
      const ids = quickActions(hasPage).map(action => action.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
