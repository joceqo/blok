import { describe, expect, it } from 'vitest';

import { parsePresetConfig } from './preset-config.js';

describe('parsePresetConfig (read/edit roles)', () => {
  it('accepts valid read and edit workspace roles', () => {
    expect(parsePresetConfig({ read: 'guest', edit: 'member' })).toEqual({
      ok: true,
      config: { read: 'guest', edit: 'member' },
    });
  });

  it('accepts an empty config object', () => {
    expect(parsePresetConfig({})).toEqual({ ok: true, config: {} });
    expect(parsePresetConfig(undefined)).toEqual({ ok: true, config: {} });
  });

  it('rejects unknown role strings', () => {
    expect(parsePresetConfig({ read: 'superuser' })).toEqual({
      ok: false,
      reason: 'invalid_role',
    });
  });

  it('rejects non-object config', () => {
    expect(parsePresetConfig('read')).toEqual({ ok: false, reason: 'invalid_config' });
  });
});