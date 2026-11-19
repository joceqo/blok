/**
 * Environment config — mirrors Go `config.go` naming where we can.
 * Go uses `os.LookupEnv`: empty string is a set value (not “fall back”).
 */

function lookup(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  return value;
}

/** Go: `LookupEnv` — `MAILER_HOST=""` must not fall through to `SMTP_HOST`. */
function lookupOr(other: string, fallback: string): string | undefined {
  const primary = lookup(other);
  if (primary !== undefined) {
    return primary;
  }
  return lookup(fallback);
}

export interface ServiceConfig {
  port: number;
  databaseUrl: string | undefined;
  mailerHost: string | undefined;
  /** Public base URL for links in email (setup, invites). */
  publicUrl: string | undefined;
  /** Path to schema.sql (applied on boot when DB is empty). */
  schemaSqlPath: string | undefined;
}

export function loadConfig(): ServiceConfig {
  const portRaw = lookup('PORT') ?? '8080';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${portRaw}`);
  }

  return {
    port,
    databaseUrl: lookup('DATABASE_URL') ?? lookup('TEST_DATABASE_URL'),
    mailerHost: lookupOr('MAILER_HOST', 'SMTP_HOST'),
    publicUrl: lookup('PUBLIC_URL'),
    schemaSqlPath: lookup('SCHEMA_SQL_PATH'),
  };
}