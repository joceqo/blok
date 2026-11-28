import { describe, expect, it } from 'vitest';

import { parsePresetCreateBody, parsePresetPatchBody } from './preset-body.ts';

describe('parsePresetCreateBody', () => {
  it('accepts name and config', () => {
    expect(
      parsePresetCreateBody({ name: ' Editors ', config: { read: 'guest', edit: 'member' } }),
    ).toEqual({
      ok: true,
      name: 'Editors',
      config: { read: 'guest', edit: 'member' },
    });
  });

  it('rejects missing or blank name', () => {
    expect(parsePresetCreateBody({ config: {} })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(parsePresetCreateBody({ name: '   ' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects non-object body', () => {
    expect(parsePresetCreateBody(null)).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('rejects invalid config', () => {
    expect(parsePresetCreateBody({ name: 'X', config: { read: 'nope' } })).toEqual({
      ok: false,
      reason: 'invalid_role',
    });
  });
});

describe('parsePresetPatchBody', () => {
  it('accepts name-only, config-only, or both', () => {
    expect(parsePresetPatchBody({ name: ' Team ' })).toEqual({
      ok: true,
      updates: { name: 'Team' },
    });
    expect(parsePresetPatchBody({ config: { edit: 'admin' } })).toEqual({
      ok: true,
      updates: { config: { edit: 'admin' } },
    });
    expect(parsePresetPatchBody({ name: 'A', config: {} })).toEqual({
      ok: true,
      updates: { name: 'A', config: {} },
    });
  });

  it('rejects empty patch', () => {
    expect(parsePresetPatchBody({})).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('rejects blank name when name is present', () => {
    expect(parsePresetPatchBody({ name: '  ' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects invalid config', () => {
    expect(parsePresetPatchBody({ config: [] })).toEqual({
      ok: false,
      reason: 'invalid_config',
    });
  });
});