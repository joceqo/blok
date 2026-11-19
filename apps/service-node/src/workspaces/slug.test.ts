import { describe, expect, it } from 'vitest';

import { slugFromName } from './slug.js';

describe('slugFromName', () => {
  it('slugifies names', () => {
    expect(slugFromName('My Team')).toBe('my-team');
  });

  it('falls back when empty', () => {
    expect(slugFromName('   ').startsWith('ws-')).toBe(true);
  });
});