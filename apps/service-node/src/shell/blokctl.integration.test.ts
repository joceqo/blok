import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBlokctl } from './blokctl.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('instance recovery commands', () => {
  const schema = 'ops_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  const db = new pg.Pool({ connectionString: url, options: '-csearch_path=' + schema });
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    await db.end();
    try {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.end();
    }
  });
  it('grants and removes admins concurrently while retaining one administrator', async () => {
    for (const mail of ['a@test', 'b@test']) await runBlokctl(db, ['admin', 'grant', mail]);
    expect(await runBlokctl(db, ['admin', 'list'])).toBe('a@test\nb@test');
    const results = await Promise.allSettled(
      ['a@test', 'b@test'].map((mail) => runBlokctl(db, ['admin', 'revoke', mail])),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await runBlokctl(db, ['admin', 'list'])).toMatch(/^[ab]@test$/);
    await expect(runBlokctl(db, ['admin', 'grant', 'bad address'])).rejects.toThrow('Invalid email');
  });
  it('applies the same settings contract as HTTP and refuses unknown workspaces', async () => {
    const patch = ['name=Démo', 'signup-policy=domain', 'signup-domains= One.Example, Two.Example '];
    const settings = JSON.parse(await runBlokctl(db, ['settings', 'set', ...patch]));
    expect(settings).toMatchObject({
      name: 'Démo',
      signupPolicy: 'domain',
      signupDomains: ['one.example', 'two.example'],
    });
    await expect(runBlokctl(db, ['settings', 'set', 'default-workspace-id=unknown'])).rejects.toThrow();
    expect(JSON.parse(await runBlokctl(db, ['settings', 'show']))).toEqual(settings);
  });
});
