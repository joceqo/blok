import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The development build must not share anything addressable with the installed
 * app: not its data directory, not its URL scheme. They did, and a `tauri dev`
 * run wrote into the files of the app the user had open.
 */
const config = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), 'src-tauri', name), 'utf8')) as Record<string, unknown>;

const schemes = (value: Record<string, unknown>): unknown => {
  const plugins = value.plugins as { 'deep-link'?: { desktop?: { schemes?: unknown } } } | undefined;
  return plugins?.['deep-link']?.desktop?.schemes;
};

it('gives the development build its own data directory', () => {
  expect(config('tauri.dev.conf.json').identifier).not.toBe(config('tauri.conf.json').identifier);
});

it('gives the development build its own url scheme, so deep links open the intended app', () => {
  expect(schemes(config('tauri.dev.conf.json'))).not.toEqual(schemes(config('tauri.conf.json')));
});

/** Sharing the port means whichever started first answers for both. */
it('gives the development build its own dev server port', () => {
  const build = (name: string): { devUrl?: string } => (config(name).build ?? {}) as { devUrl?: string };
  expect(build('tauri.dev.conf.json').devUrl).toBeDefined();
  expect(build('tauri.dev.conf.json').devUrl).not.toBe(build('tauri.conf.json').devUrl);
});

it('names the development build apart in the dock', () => {
  expect(config('tauri.dev.conf.json').productName).not.toBe(config('tauri.conf.json').productName);
});

/** An override that restates shared settings drifts from the real config in silence. */
it('overrides only what must differ', () => {
  expect(Object.keys(config('tauri.dev.conf.json')).sort()).toEqual(['$schema', 'build', 'identifier', 'plugins', 'productName']);
});
