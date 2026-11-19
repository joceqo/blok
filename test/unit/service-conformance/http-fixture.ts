import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HttpFixtureExpect {
  status: number;
  body: unknown;
}

export interface HttpFixtureCase {
  name: string;
  method: string;
  path: string;
  expect: HttpFixtureExpect;
}

export interface HttpFixtureFile {
  description?: string;
  cases: HttpFixtureCase[];
}

export const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

export const loadHttpFixture = (file: string): HttpFixtureFile => {
  const parsed = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as HttpFixtureFile;

  if (!Array.isArray(parsed.cases)) {
    throw new Error(`${file} has no "cases" array`);
  }

  return parsed;
};