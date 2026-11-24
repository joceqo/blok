import { describe, expect, it } from 'vitest';

import { equalsOrdinalIgnoreCase } from '../dotnet/ordinal.ts';

describe('@fast ordinal ignore case', () => {
  it('folds ASCII but not Turkish dotted I', () => {
    expect(equalsOrdinalIgnoreCase('http://k.example', 'HTTP://K.EXAMPLE')).toBe(true);
    expect(equalsOrdinalIgnoreCase('http://ı.example', 'http://I.example')).toBe(false);
  });
});