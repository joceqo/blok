import { createPhase0Handler } from './host/handler.ts';
import { defaultConfig, listen, parseIp, Server, shutdownSignal } from './http/index.ts';
// Bundled as a string by esbuild (--loader:.txt=text); must not be read from disk
// after the binary is copied into the conformance temp directory.
import USAGE from './args/usage.txt';

declare const BLOK_CONFORMANCE: boolean | undefined;
const conformanceBuild = typeof BLOK_CONFORMANCE !== 'undefined' && BLOK_CONFORMANCE === true;

const VERSION = typeof process.env.BLOK_SERVER_VERSION === 'string' && process.env.BLOK_SERVER_VERSION.length > 0
  ? process.env.BLOK_SERVER_VERSION
  : 'dev';
const NEWLINE = process.platform === 'win32' ? '\r\n' : '\n';

interface ParsedArgv {
  help: boolean;
  err: string;
  listen: string;
  auth: string;
  noUnfurl: boolean;
}

function parseArgv(argv: string[]): ParsedArgv {
  let listen = '127.0.0.1:4000';
  let auth = 'none';
  let noUnfurl = false;
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
    if (name === 'listen') {
      const value = inline ?? argv[++index];
      if (value === undefined) {
        err = 'flag needs an argument: -listen';
        break;
      }
      listen = value;
      continue;
    }
    if (name === 'auth') {
      const value = inline ?? argv[++index];
      if (value === undefined) {
        err = 'flag needs an argument: -auth';
        break;
      }
      auth = value;
      continue;
    }
    err = `flag provided but not defined: -${name}`;
    break;
  }
  return { help, err, listen, auth, noUnfurl };
}

function print(text: string): void {
  process.stderr.write(text);
  process.stderr.write(NEWLINE);
}

async function run(): Promise<number> {
  // argv[0]=node, argv[1]=script — same as Go's os.Args[1:] after the binary name.
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.help) {
    print(USAGE);
    return 0;
  }
  if (parsed.err.length > 0) {
    print(`${parsed.err}${NEWLINE}${USAGE}`);
    return 2;
  }
  let servers;
  try {
    servers = await listen(parsed.listen, parseIp);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`blok-server refused to start: ${message}${NEWLINE}`);
    return 1;
  }
  const http = new Server(createPhase0Handler(VERSION, parsed.noUnfurl), defaultConfig());
  const shuttingDown = shutdownSignal();
  const serving = http.serveStd(servers);
  // The harness trusts /health only after this line, so it must follow the bind.
  print(`blok-server ${VERSION} listening on ${parsed.listen} (--auth ${parsed.auth})`);
  await shuttingDown;
  await http.shutdown(30_000);
  await serving;
  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    print(`blok-server stopped: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
