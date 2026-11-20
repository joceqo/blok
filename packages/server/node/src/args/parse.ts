import { csQuote, parseBaseZeroInt64 } from './numbers.ts';

export interface ParsedHostArgs {
  help: boolean;
  err: string;
  listen: string;
  auth: string;
  noUnfurl: boolean;
  storageDirectory: string;
  /** Set when `--rate-limit` was passed; otherwise absent for ticket/default handling in main. */
  rateLimitPerMinute?: number;
  /** Set when `--public-url` was passed; otherwise absent for listen-based default in main. */
  publicUrl?: string;
}

const DEFAULT_LISTEN = '127.0.0.1:4000';
const DEFAULT_AUTH = 'none';
const DEFAULT_STORAGE_DIRECTORY = './blok-uploads';

function isValueFlag(name: string): boolean {
  return (
    name === 'listen'
    || name === 'auth'
    || name === 'storage-dir'
    || name === 'public-url'
    || name === 'rate-limit'
  );
}

function parseError(name: string, value: string): string {
  return `invalid value ${csQuote(value)} for flag -${name}: parse error`;
}

export function parseHostArguments(argv: string[], conformanceBuild: boolean): ParsedHostArgs {
  let listen = DEFAULT_LISTEN;
  let auth = DEFAULT_AUTH;
  let noUnfurl = false;
  let storageDirectory = DEFAULT_STORAGE_DIRECTORY;
  let rateLimitPerMinute: number | undefined;
  let publicUrl: string | undefined;
  let help = false;
  let err = '';
  const conformanceOnly = /^--conformance-/;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--' || argument.length < 2 || !argument.startsWith('-')) {
      break;
    }
    const nameAndValue = argument.startsWith('--') ? argument.slice(2) : argument.slice(1);
    const eq = nameAndValue.indexOf('=');
    const name = eq >= 0 ? nameAndValue.slice(0, eq) : nameAndValue;
    const inline = eq >= 0 ? nameAndValue.slice(eq + 1) : undefined;
    if (name === 'h' || name === 'help') {
      help = true;
      continue;
    }
    if (!conformanceBuild && (conformanceOnly.test(`--${name}`) || name.startsWith('conformance-'))) {
      err = `flag provided but not defined: -${name}`;
      break;
    }
    if (name === 'no-unfurl') {
      noUnfurl = inline === undefined ? true : inline === 'true' || inline === '1';
      continue;
    }
    if (!isValueFlag(name)) {
      err = `flag provided but not defined: -${name}`;
      break;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) {
      err = `flag needs an argument: -${name}`;
      break;
    }
    switch (name) {
      case 'listen':
        listen = value;
        break;
      case 'auth':
        auth = value;
        break;
      case 'storage-dir':
        storageDirectory = value;
        break;
      case 'public-url':
        publicUrl = value;
        break;
      case 'rate-limit': {
        const parsed = parseBaseZeroInt64(value);
        if (parsed === undefined) {
          err = parseError(name, value);
        } else {
          rateLimitPerMinute = parsed;
        }
        break;
      }
      default:
        err = `flag provided but not defined: -${name}`;
        break;
    }
    if (err.length > 0) {
      break;
    }
  }
  return {
    help,
    err,
    listen,
    auth,
    noUnfurl,
    storageDirectory,
    rateLimitPerMinute,
    publicUrl,
  };
}