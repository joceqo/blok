import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.ts';

const CONFIG_ENV_KEYS = [
  'PORT',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'MAILER_HOST',
  'SMTP_HOST',
  'PUBLIC_URL',
  'SCHEMA_SQL_PATH',
  'BLOK_SIDECAR_URL',
  'BLOK_SECRET',
] as const;

describe('loadConfig', () => {
  const saved: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('defaults PORT to 8080 when unset', () => {
    expect(loadConfig().port).toBe(8080);
  });

  it('throws on invalid PORT', () => {
    process.env.PORT = 'not-a-port';
    expect(() => loadConfig()).toThrow(/invalid PORT/);
  });

  it('allows BLOK_SECRET to be unset', () => {
    expect(() => loadConfig()).not.toThrow();
  });

  it('throws when BLOK_SECRET is shorter than 32 characters', () => {
    process.env.BLOK_SECRET = 'too-short';
    expect(() => loadConfig()).toThrow(
      'BLOK_SECRET must be at least 32 characters (got 9)',
    );
  });

  it('throws when BLOK_SECRET is an empty string', () => {
    process.env.BLOK_SECRET = '';
    expect(() => loadConfig()).toThrow(
      'BLOK_SECRET must be at least 32 characters (got 0)',
    );
  });

  it('accepts BLOK_SECRET with at least 32 characters', () => {
    process.env.BLOK_SECRET = 'a'.repeat(32);
    expect(() => loadConfig()).not.toThrow();
  });
});