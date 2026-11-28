import { defaultPublicUrl, resolveRateLimitPerMinute } from './public-url.ts';
import { parseBool } from './bool.ts';
import { splitOrigins } from './origins.ts';
import { csQuote, parseBaseZeroInt64 } from './numbers.ts';
import { parseRichTextFields } from './rich-text-fields.ts';

export interface ParsedHostArgs {
  help: boolean;
  err: string;
  listen: string;
  auth: string;
  secret: string;
  secretFromFlag: boolean;
  allowedOrigins: string[];
  storageDirectory: string;
  publicUrl: string;
  maxUploadBytes?: number;
  rateLimitPerMinute: number;
  unfurlDisabled: boolean;
  fileBytesEnabled: boolean;
  filesCors: boolean;
  fileBytesMaxBytes?: number;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3BucketUrl: string;
  s3Addressing: string;
  s3AccessKey: string;
  s3SecretKey: string;
  collabEnabled: boolean;
  docEndpoint: string;
  docEndpointAuth: string;
  docEndpointAuthFromFlag: boolean;
  collabDirectory: string;
  collabS3Prefix: string;
  collabJournal: boolean;
  richTextFields: Record<string, string[]>;
}

const DEFAULT_LISTEN = '127.0.0.1:4000';
const DEFAULT_AUTH = 'none';
const DEFAULT_STORAGE_DIRECTORY = './blok-uploads';
const DEFAULT_COLLAB_DIRECTORY = './blok-collab';

function isValueFlag(name: string): boolean {
  return (
    name === 'listen'
    || name === 'auth'
    || name === 'secret'
    || name === 'allow-origin'
    || name === 'storage-dir'
    || name === 'public-url'
    || name === 'max-upload'
    || name === 'file-bytes-max-bytes'
    || name === 'rate-limit'
    || name === 's3-endpoint'
    || name === 's3-region'
    || name === 's3-bucket'
    || name === 's3-bucket-url'
    || name === 's3-addressing'
    || name === 'doc-endpoint'
    || name === 'doc-endpoint-auth'
    || name === 'collab-dir'
    || name === 'collab-s3-prefix'
    || name === 'rich-text-fields'
  );
}

function parseError(name: string, value: string): string {
  return `invalid value ${csQuote(value)} for flag -${name}: parse error`;
}

function envError(name: string, value: string): string {
  return `invalid value ${csQuote(value)} for ${name}: parse error`;
}

function parseBooleanFlag(
  name: string,
  inline: string | undefined,
  onValue: (enabled: boolean) => void,
): string {
  if (inline === undefined) {
    onValue(true);
    return '';
  }
  const parsed = parseBool(inline);
  if (parsed === undefined) {
    return parseError(name, inline);
  }
  onValue(parsed);
  return '';
}

export function parseHostArguments(
  argv: string[],
  conformanceBuild: boolean,
  getenv: (name: string) => string = (name) => process.env[name] ?? '',
): ParsedHostArgs {
  let listen = DEFAULT_LISTEN;
  let auth = DEFAULT_AUTH;
  let secret = '';
  let secretFromFlag = false;
  let originsText = '';
  let storageDirectory = DEFAULT_STORAGE_DIRECTORY;
  let publicUrlText = '';
  let maxUploadBytes: number | undefined;
  let rateLimit: number | undefined;
  let unfurlDisabled = false;
  let fileBytesEnabled = false;
  let filesCors = false;
  let fileBytesMaxBytes: number | undefined;
  let s3Endpoint = '';
  let s3Region = '';
  let s3Bucket = '';
  let s3BucketUrl = '';
  let s3Addressing = '';
  let collabEnabled = false;
  let docEndpoint = '';
  let docEndpointAuth = '';
  let docEndpointAuthFromFlag = false;
  let collabDirectory = DEFAULT_COLLAB_DIRECTORY;
  let collabS3Prefix = '';
  let collabJournal = false;
  let collabJournalFromFlag = false;
  let richTextFields: Record<string, string[]> = {};
  let richTextFieldsFromFlag = false;
  let help = false;
  let err = '';
  const conformanceOnly = /^--conformance-/;

  for (let index = 0; index < argv.length; index += 1) {
    // In range by the loop bound; the fallback is what noUncheckedIndexedAccess
    // costs without a non-null assertion, and an absent argument stops the scan
    // exactly as a non-flag one would.
    const argument = argv[index] ?? '';
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
      const flagErr = parseBooleanFlag(name, inline, (disabled) => {
        unfurlDisabled = disabled;
      });
      if (flagErr.length > 0) {
        err = flagErr;
        break;
      }
      continue;
    }

    if (name === 'collab') {
      const flagErr = parseBooleanFlag(name, inline, (enabled) => {
        collabEnabled = enabled;
      });
      if (flagErr.length > 0) {
        err = flagErr;
        break;
      }
      continue;
    }

    if (name === 'file-bytes' || name === 'files-cors') {
      if (inline === undefined) {
        if (name === 'file-bytes') {
          fileBytesEnabled = true;
        } else {
          filesCors = true;
        }
        continue;
      }
      const parsed = parseBool(inline);
      if (parsed === undefined) {
        err = parseError(name, inline);
        break;
      }
      if (name === 'file-bytes') {
        fileBytesEnabled = parsed;
      } else {
        filesCors = parsed;
      }
      continue;
    }

    if (name === 'collab-journal') {
      collabJournalFromFlag = true;
      const flagErr = parseBooleanFlag(name, inline, (journal) => {
        collabJournal = journal;
      });
      if (flagErr.length > 0) {
        err = flagErr;
        break;
      }
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
      case 'secret':
        secret = value;
        secretFromFlag = true;
        break;
      case 'allow-origin':
        originsText = value;
        break;
      case 'storage-dir':
        storageDirectory = value;
        break;
      case 'public-url':
        publicUrlText = value;
        break;
      case 'max-upload': {
        const parsed = parseBaseZeroInt64(value);
        if (parsed === undefined) {
          err = parseError(name, value);
        } else {
          maxUploadBytes = parsed;
        }
        break;
      }
      case 'file-bytes-max-bytes': {
        const parsed = parseBaseZeroInt64(value);
        if (parsed === undefined) {
          err = parseError(name, value);
        } else {
          fileBytesMaxBytes = parsed;
        }
        break;
      }
      case 'rate-limit': {
        const parsed = parseBaseZeroInt64(value);
        if (parsed === undefined) {
          err = parseError(name, value);
        } else {
          rateLimit = parsed;
        }
        break;
      }
      case 's3-endpoint':
        s3Endpoint = value;
        break;
      case 's3-region':
        s3Region = value;
        break;
      case 's3-bucket':
        s3Bucket = value;
        break;
      case 's3-bucket-url':
        s3BucketUrl = value;
        break;
      case 's3-addressing':
        s3Addressing = value;
        break;
      case 'doc-endpoint':
        docEndpoint = value;
        break;
      case 'doc-endpoint-auth':
        docEndpointAuth = value;
        docEndpointAuthFromFlag = true;
        break;
      case 'collab-dir':
        collabDirectory = value;
        break;
      case 'collab-s3-prefix':
        collabS3Prefix = value;
        break;
      case 'rich-text-fields': {
        const parsed = parseRichTextFields(value);
        if (parsed === undefined) {
          err = parseError(name, value);
        } else {
          richTextFields = parsed;
          richTextFieldsFromFlag = true;
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

  if (err.length > 0 || help) {
    return {
      help,
      err,
      listen,
      auth,
      secret,
      secretFromFlag,
      allowedOrigins: splitOrigins(originsText),
      storageDirectory,
      publicUrl: publicUrlText === '' ? defaultPublicUrl(listen) : publicUrlText,
      maxUploadBytes,
      rateLimitPerMinute: resolveRateLimitPerMinute(auth, rateLimit),
      unfurlDisabled,
      fileBytesEnabled,
      filesCors,
      fileBytesMaxBytes,
      s3Endpoint,
      s3Region,
      s3Bucket,
      s3BucketUrl,
      s3Addressing,
      s3AccessKey: '',
      s3SecretKey: '',
      collabEnabled,
      docEndpoint,
      docEndpointAuth,
      docEndpointAuthFromFlag,
      collabDirectory,
      collabS3Prefix,
      collabJournal,
      richTextFields,
    };
  }

  if (!secretFromFlag) {
    secret = getenv('BLOK_SECRET');
  }
  if (!docEndpointAuthFromFlag) {
    docEndpointAuth = getenv('BLOK_DOC_ENDPOINT_AUTH');
  }
  if (!collabJournalFromFlag) {
    const journalVariable = getenv('BLOK_COLLAB_JOURNAL');
    if (journalVariable !== '') {
      const journal = parseBool(journalVariable);
      if (journal === undefined) {
        err = envError('BLOK_COLLAB_JOURNAL', journalVariable);
      } else {
        collabJournal = journal;
      }
    }
  }
  if (!richTextFieldsFromFlag) {
    const fieldsVariable = getenv('BLOK_RICH_TEXT_FIELDS');
    if (fieldsVariable !== '') {
      const parsed = parseRichTextFields(fieldsVariable);
      if (parsed === undefined) {
        err = envError('BLOK_RICH_TEXT_FIELDS', fieldsVariable);
      } else {
        richTextFields = parsed;
      }
    }
  }

  return {
    help,
    err,
    listen,
    auth,
    secret,
    secretFromFlag,
    allowedOrigins: splitOrigins(originsText),
    storageDirectory,
    publicUrl: publicUrlText === '' ? defaultPublicUrl(listen) : publicUrlText,
    maxUploadBytes,
    rateLimitPerMinute: resolveRateLimitPerMinute(auth, rateLimit),
    unfurlDisabled,
    fileBytesEnabled,
    filesCors,
    fileBytesMaxBytes,
    s3Endpoint,
    s3Region,
    s3Bucket,
    s3BucketUrl,
    s3Addressing,
    s3AccessKey: getenv('BLOK_S3_ACCESS_KEY'),
    s3SecretKey: getenv('BLOK_S3_SECRET_KEY'),
    collabEnabled,
    docEndpoint,
    docEndpointAuth,
    docEndpointAuthFromFlag,
    collabDirectory,
    collabS3Prefix,
    collabJournal,
    richTextFields,
  };
}