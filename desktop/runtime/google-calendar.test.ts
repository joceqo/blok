import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { googleCalendarEnv } from './google-calendar.ts';

const origin = 'http://127.0.0.1:52430';
const callback = origin + '/api/calendar/google/callback';

async function dataDirectory(contents?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'blok-gcal-'));
  if (contents !== undefined) await writeFile(join(directory, 'google-calendar.json'), contents);
  return directory;
}

void test('an installed app reads its Google client from the data directory, on the origin this launch listens on', async () => {
  const data = await dataDirectory('{"clientId":"installed-id","clientSecret":"installed-secret"}');
  try {
    assert.deepEqual(await googleCalendarEnv(data, origin, {}), {
      GOOGLE_CALENDAR_CLIENT_ID: 'installed-id',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'installed-secret',
      GOOGLE_CALENDAR_REDIRECT_URI: callback,
    });
  } finally { await rm(data, { recursive: true, force: true }); }
});

void test('the surrounding environment wins, and configures nothing on its own', async () => {
  const data = await dataDirectory('{"clientId":"installed-id","clientSecret":"installed-secret"}');
  try {
    const env = { GOOGLE_CALENDAR_CLIENT_ID: 'env-id', GOOGLE_CALENDAR_CLIENT_SECRET: 'env-secret' };
    assert.deepEqual(await googleCalendarEnv(data, origin, env), {
      GOOGLE_CALENDAR_CLIENT_ID: 'env-id',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'env-secret',
      GOOGLE_CALENDAR_REDIRECT_URI: callback,
    });
    // A hosted deployment states its own callback; the launch origin never overrides it.
    const hosted = { ...env, GOOGLE_CALENDAR_REDIRECT_URI: 'https://blok.example/api/calendar/google/callback' };
    assert.equal((await googleCalendarEnv(data, origin, hosted)).GOOGLE_CALENDAR_REDIRECT_URI, hosted.GOOGLE_CALENDAR_REDIRECT_URI);
  } finally { await rm(data, { recursive: true, force: true }); }
});

void test('an absent, unreadable or incomplete client leaves Google Calendar unconfigured', async () => {
  const missing = await dataDirectory();
  const broken = await dataDirectory('not json');
  const partial = await dataDirectory('{"clientId":"installed-id"}');
  try {
    for (const data of [missing, broken, partial]) assert.deepEqual(await googleCalendarEnv(data, origin, {}), {});
  } finally {
    for (const data of [missing, broken, partial]) await rm(data, { recursive: true, force: true });
  }
});
