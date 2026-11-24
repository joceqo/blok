import { csQuote } from './numbers.ts';

const ORIGIN_PREFIX = 'http://127.0.0.1:';
const ORIGIN_REQUIREMENT =
  'must be exactly http://127.0.0.1:PORT with a port from 1 to 65535 and no userinfo, path, query, or fragment';

export interface ParsedConformanceArgs {
  argv: string[];
  err: string;
  origin: string;
  port: number;
  fileBytes: boolean;
  fileBytesMaxBytes?: number;
  filesCors: boolean;
  journal: boolean;
}

function isDigits(text: string): boolean {
  if (text === '') {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      return false;
    }
  }
  return true;
}

function parseOriginValue(value: string): { origin: string; port: number } | string {
  const portText = value.startsWith(ORIGIN_PREFIX) ? value.slice(ORIGIN_PREFIX.length) : '';
  const port = Number.parseInt(portText, 10);
  if (!isDigits(portText) || port < 1 || port > 65535 || value !== `${ORIGIN_PREFIX}${portText}`) {
    return `${ORIGIN_REQUIREMENT} (got ${csQuote(value)})`;
  }
  return { origin: value, port };
}

/** Strips conformance-only flags before the host parser runs. */
export function parseConformanceArguments(argv: string[]): ParsedConformanceArgs {
  const filtered: string[] = [];
  let origin = '';
  let port = 0;
  let fileBytes = false;
  let fileBytesMaxBytes: number | undefined;
  let filesCors = false;
  let journal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--') {
      filtered.push(...argv.slice(index));
      break;
    }
    if (argument === '--conformance-journal' || argument === '-conformance-journal') {
      journal = true;
      continue;
    }
    if (argument === '--conformance-file-bytes' || argument === '-conformance-file-bytes') {
      fileBytes = true;
      continue;
    }
    if (argument === '--conformance-files-cors' || argument === '-conformance-files-cors') {
      filesCors = true;
      continue;
    }
  if (
      argument.startsWith('--conformance-file-bytes-max-bytes=')
      || argument.startsWith('-conformance-file-bytes-max-bytes=')
    ) {
      const eq = argument.indexOf('=');
      const text = argument.slice(eq + 1);
      const bytes = Number.parseInt(text, 10);
      if (!isDigits(text) || !Number.isSafeInteger(bytes)) {
        return emptyErr(`--conformance-file-bytes-max-bytes must be a whole number of bytes (got ${csQuote(text)})`);
      }
      fileBytesMaxBytes = bytes;
      continue;
    }
    let value = '';
    if (argument === '--conformance-origin' || argument === '-conformance-origin') {
      value = argv[++index] ?? '';
      if (value === '') {
        return emptyErr('flag needs an argument: -conformance-origin');
      }
    } else if (argument.startsWith('--conformance-origin=')) {
      value = argument.slice('--conformance-origin='.length);
    } else if (argument.startsWith('-conformance-origin=')) {
      value = argument.slice('-conformance-origin='.length);
    } else if (
      argument.startsWith('--conformance-')
      || argument.startsWith('-conformance-')
    ) {
      continue;
    } else {
      filtered.push(argument);
      continue;
    }
    const parsed = parseOriginValue(value);
    if (typeof parsed === 'string') {
      return emptyErr(parsed);
    }
    origin = parsed.origin;
    port = parsed.port;
  }

  return { argv: filtered, err: '', origin, port, fileBytes, fileBytesMaxBytes, filesCors, journal };
}

function emptyErr(message: string): ParsedConformanceArgs {
  return { argv: [], err: message, origin: '', port: 0, fileBytes: false, filesCors: false, journal: false };
}