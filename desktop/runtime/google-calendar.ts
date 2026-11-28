import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The server's own callback path. Kept in step with googleCallback in
// apps/service-node/src/shell/google-calendar-provider.ts.
const callback = '/api/calendar/google/callback';

/**
 * A packaged app inherits no shell environment, so an installed instance reads
 * its Google client from the data directory instead. Its callback is derived
 * from the origin it serves: the port is stable per installation, but it is
 * chosen on the user's machine, so it cannot ship with the app.
 */
export async function googleCalendarEnv(data: string, publicOrigin: string, env: NodeJS.ProcessEnv = process.env) {
  const client = env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET
    ? { clientId: env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET }
    : await installedClient(data);
  if (!client) return {};
  return {
    GOOGLE_CALENDAR_CLIENT_ID: client.clientId,
    GOOGLE_CALENDAR_CLIENT_SECRET: client.clientSecret,
    GOOGLE_CALENDAR_REDIRECT_URI: env.GOOGLE_CALENDAR_REDIRECT_URI ?? publicOrigin + callback,
  };
}

async function installedClient(data: string) {
  try {
    const stored = JSON.parse(await readFile(join(data, 'google-calendar.json'), 'utf8')) as Record<string, unknown>;
    if (typeof stored?.clientId !== 'string' || typeof stored.clientSecret !== 'string') return;
    return { clientId: stored.clientId, clientSecret: stored.clientSecret };
  } catch { return; /* this instance has no Google client installed */ }
}
