import { publicPathFromUrl } from './args/public-url.ts';
import { parseConformanceArguments } from './args/conformance.ts';
import { parseHostArguments } from './args/parse.ts';
import { validateHostStartup } from './args/validate-startup.ts';
import { createHostHandler } from './host/app.ts';
import { collabLogger } from './collab/log.ts';
import { defaultMaxUpload } from './host/upload.ts';
import { RateLimiter } from './host/rate-limit.ts';
import { defaultConfig, listen, parseIp, Server, shutdownSignal } from './http/index.ts';
import { DefaultBlockedPolicy, ExactOriginPolicy, OutboundFetcher } from './outbound/fetcher.ts';
// Bundled as a string by esbuild (--loader:.txt=text); must not be read from disk
// after the binary is copied into the conformance temp directory.
import USAGE from './args/usage.txt';

declare const BLOK_CONFORMANCE: boolean | undefined;
const conformanceBuild = typeof BLOK_CONFORMANCE !== 'undefined' && BLOK_CONFORMANCE === true;

const VERSION = typeof process.env.BLOK_SERVER_VERSION === 'string' && process.env.BLOK_SERVER_VERSION.length > 0
  ? process.env.BLOK_SERVER_VERSION
  : 'dev';
const DEFAULT_FILE_BYTES_MAX = 100 << 20;
const NEWLINE = process.platform === 'win32' ? '\r\n' : '\n';

function print(text: string): void {
  process.stderr.write(text);
  process.stderr.write(NEWLINE);
}

function defaultFileBytesMax(fromFlag: number | undefined): number {
  return fromFlag ?? DEFAULT_FILE_BYTES_MAX;
}

async function run(): Promise<number> {
  let argv = process.argv.slice(2);
  let conformance = parseConformanceArguments(argv);
  if (conformanceBuild) {
    if (conformance.err.length > 0) {
      print(`${conformance.err}${NEWLINE}${USAGE}`);
      return 2;
    }
    argv = conformance.argv;
  }
  const parsed = parseHostArguments(argv, conformanceBuild);
  if (parsed.help) {
    print(USAGE);
    return 0;
  }
  if (parsed.err.length > 0) {
    print(`${parsed.err}${NEWLINE}${USAGE}`);
    return 2;
  }
  const startupErr = validateHostStartup(parsed);
  if (startupErr !== undefined) {
    print(`blok-server refused to start: ${startupErr}`);
    return 1;
  }
  if (parsed.secretFromFlag) {
    print('warning: --secret puts the shared secret in this machine\'s process list; set BLOK_SECRET in the environment instead');
  }
  if (parsed.docEndpointAuthFromFlag) {
    print('warning: --doc-endpoint-auth puts the credential in this machine\'s process list; set BLOK_DOC_ENDPOINT_AUTH in the environment instead');
  }
  let servers;
  try {
    servers = await listen(parsed.listen, parseIp);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`blok-server refused to start: ${message}`);
    return 1;
  }
  const fileBytesEnabled = parsed.fileBytesEnabled || conformance.fileBytes;
  const filesCors = parsed.filesCors || conformance.filesCors;
  const fileBytesMaxBytes = defaultFileBytesMax(conformance.fileBytesMaxBytes ?? parsed.fileBytesMaxBytes);
  const fetcher = new OutboundFetcher(
    conformance.port > 0
      ? new ExactOriginPolicy(conformance.origin, conformance.port)
      : new DefaultBlockedPolicy(),
  );
  const http = new Server(createHostHandler({
    version: VERSION,
    auth: parsed.auth,
    secret: parsed.secret,
    unfurlDisabled: parsed.unfurlDisabled,
    unfurlEnabled: !parsed.unfurlDisabled,
    storageDirectory: parsed.storageDirectory,
    publicPath: publicPathFromUrl(parsed.publicUrl),
    publicUrl: parsed.publicUrl,
    maxUploadBytes: defaultMaxUpload(parsed.maxUploadBytes),
    collabEnabled: parsed.collabEnabled,
    docEndpoint: parsed.docEndpoint,
    docEndpointAuth: parsed.docEndpointAuth,
    collabLog: collabLogger(process.stderr),
    allowedOrigins: parsed.allowedOrigins,
    fileBytesEnabled,
    fileBytesMaxBytes,
    filesCors,
    fetcher,
    rateLimiter: new RateLimiter(parsed.rateLimitPerMinute),
  }), defaultConfig());
  const shuttingDown = shutdownSignal();
  const serving = http.serveStd(servers);
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