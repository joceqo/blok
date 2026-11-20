import { validatePublicUrl, validateRateLimit } from './args/public-url.ts';
import { parseHostArguments } from './args/parse.ts';
import { createHostHandler } from './host/app.ts';
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

function print(text: string): void {
  process.stderr.write(text);
  process.stderr.write(NEWLINE);
}

async function run(): Promise<number> {
  // argv[0]=node, argv[1]=script — same as Go's os.Args[1:] after the binary name.
  const parsed = parseHostArguments(process.argv.slice(2), conformanceBuild);
  if (parsed.help) {
    print(USAGE);
    return 0;
  }
  if (parsed.err.length > 0) {
    print(`${parsed.err}${NEWLINE}${USAGE}`);
    return 2;
  }
  const rateLimitErr = validateRateLimit(parsed.rateLimitPerMinute);
  if (rateLimitErr !== undefined) {
    print(`blok-server refused to start: ${rateLimitErr}${NEWLINE}`);
    return 1;
  }
  const publicUrlErr = validatePublicUrl(parsed.publicUrl);
  if (publicUrlErr !== undefined) {
    print(`blok-server refused to start: ${publicUrlErr}${NEWLINE}`);
    return 1;
  }
  let servers;
  try {
    servers = await listen(parsed.listen, parseIp);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`blok-server refused to start: ${message}${NEWLINE}`);
    return 1;
  }
  const http = new Server(createHostHandler({
    version: VERSION,
    unfurlDisabled: parsed.unfurlDisabled,
    storageDirectory: parsed.storageDirectory,
  }), defaultConfig());
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