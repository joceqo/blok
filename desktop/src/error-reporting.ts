/**
 * Browser-side error reporting to a Sentry-compatible collector.
 *
 * The server only ever sees refused HTTP requests. The state that actually
 * strands a person — operations sitting in quarantine, a save status stuck on
 * error — lives in IndexedDB and never reaches it. Four such operations went
 * unnoticed for four days because nothing here reported them.
 *
 * Same wire protocol as the Go side, no SDK: one POST, three lines.
 */

/** What replaces anything that might carry document text. */
export const ASSET_SCRUB = '[retiré]';
const MESSAGE_LIMIT = 1000;

export interface ReportEvent {
  message: string;
  level: 'error' | 'warning' | 'info';
  tags?: Record<string, string>;
  environment?: string;
  release?: string;
}

/** Addresses and long opaque strings reach us from documents: never assume they are safe to send. */
export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ASSET_SCRUB)
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, ASSET_SCRUB)
    .replace(/\b(token|secret|key|password|authorization|cookie)\s*[=:]\s*\S+/gi, ASSET_SCRUB)
    .slice(0, MESSAGE_LIMIT);
}

export function parseReportingDsn(dsn: string): { endpoint: string; key: string } | null {
  if (dsn.trim() === '') return null;
  try {
    const url = new URL(dsn.trim());
    const project = url.pathname.replace(/^\/+|\/+$/g, '');
    if (url.username === '' || project === '' || !/^\d+$/.test(project)) return null;
    return { endpoint: `${url.protocol}//${url.host}/api/${project}/envelope/`, key: url.username };
  } catch { return null; }
}

const identifier = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function buildEnvelope(event: ReportEvent, _key: string): string {
  const stamp = new Date().toISOString();
  const id = identifier();
  const payload = JSON.stringify({
    event_id: id, timestamp: stamp, platform: 'javascript', logger: 'blok-web',
    level: event.level,
    environment: event.environment ?? 'production',
    ...(event.release === undefined ? {} : { release: event.release }),
    message: { formatted: scrub(event.message) },
    tags: Object.fromEntries(Object.entries(event.tags ?? {}).map(([k, v]) => [k, scrub(String(v))])),
  });
  return `${JSON.stringify({ event_id: id, sent_at: stamp })}\n${JSON.stringify({ type: 'event', length: payload.length })}\n${payload}\n`;
}

export interface Reporter { (): void; report: (event: ReportEvent) => void }

/**
 * Installs the reporter and returns a function that uninstalls it.
 *
 * Without a DSN nothing is hooked at all: reporting must never be the reason a
 * page misbehaves. Sending is fire-and-forget and swallows its own failures —
 * reporting a failure to report would be the one loop worth avoiding.
 */
export function installErrorReporting(options: { dsn: string; environment?: string; release?: string }): Reporter {
  const target = parseReportingDsn(options.dsn);
  const send = (event: ReportEvent): void => {
    if (!target) return;
    void fetch(target.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=blok-web/1, sentry_key=${target.key}`,
      },
      body: buildEnvelope({ environment: options.environment, release: options.release, ...event }, target.key),
      keepalive: true,
    }).catch(() => undefined);
  };
  const onError = (event: ErrorEvent): void =>
    send({ message: event.message || 'erreur non interceptée', level: 'error', tags: { source: 'window.onerror' } });
  const onRejection = (event: PromiseRejectionEvent): void =>
    send({ message: String(event.reason ?? 'promesse rejetée'), level: 'error', tags: { source: 'unhandledrejection' } });
  if (target) {
    window.addEventListener('error', onError as EventListener);
    window.addEventListener('unhandledrejection', onRejection as EventListener);
  }
  const uninstall = ((): void => {
    window.removeEventListener('error', onError as EventListener);
    window.removeEventListener('unhandledrejection', onRejection as EventListener);
  }) as Reporter;
  uninstall.report = send;
  return uninstall;
}
