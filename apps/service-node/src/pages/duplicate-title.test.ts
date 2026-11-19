import { describe, expect, it } from 'vitest';

import { duplicateTitle } from './duplicate-title.js';

describe('duplicateTitle', () => {
  it('appends a spaced Copy suffix', () => {
    expect(duplicateTitle('Roadmap')).toBe('Roadmap Copy');
  });

  it('preserves an empty title', () => {
    expect(duplicateTitle('')).toBe(' Copy');
  });

  it('does not trim the source title', () => {
    expect(duplicateTitle('  Draft  ')).toBe('  Draft   Copy');
  });
});