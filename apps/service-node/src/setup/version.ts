import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

let cachedPackageVersion: string | undefined;

function readPackageVersion(): string {
  if (cachedPackageVersion === undefined) {
    const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
    const parsed: { version?: string } = JSON.parse(raw) as { version?: string };
    cachedPackageVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  }
  return cachedPackageVersion;
}

export function readServiceVersion(): string {
  const fromEnv = process.env.SERVICE_VERSION;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return readPackageVersion();
}