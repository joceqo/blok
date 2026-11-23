import { afterEach, expect, it, vi } from 'vitest';
import { ASSET_SCRUB, buildEnvelope, installErrorReporting, parseReportingDsn, scrub } from './error-reporting';

afterEach(() => vi.restoreAllMocks());

it('parses a DSN and refuses a malformed one', () => {
  expect(parseReportingDsn('https://abc123@glitch.nexenture.fr/5')).toEqual({
    endpoint: 'https://glitch.nexenture.fr/api/5/envelope/', key: 'abc123',
  });
  for (const bad of ['', 'pas une url', 'https://glitch.nexenture.fr/5', 'https://abc@host/', 'https://abc@host/x']) {
    expect(parseReportingDsn(bad)).toBeNull();
  }
});

/** A browser report must never carry document text out of the workspace. */
it('scrubs anything that could be document content', () => {
  expect(scrub('4 opérations en quarantaine')).toBe('4 opérations en quarantaine');
  expect(scrub('échec sur https://blok.test/p/mes-specs-secretes-c8ba4a96')).toContain(ASSET_SCRUB);
  expect(scrub('échec sur https://blok.test/p/mes-specs-secretes-c8ba4a96')).not.toContain('secretes');
  expect(scrub('token=abcdef123456 refusé')).toContain(ASSET_SCRUB);
  expect(scrub('x'.repeat(2000)).length).toBeLessThanOrEqual(1000);
});

it('builds a three-line envelope with the level Sentry understands', () => {
  const lines = buildEnvelope({
    message: 'sauvegarde interrompue', level: 'error',
    tags: { état: 'quarantined', quarantaine: '4' }, environment: 'production', release: 'x',
  }, 'abc123').split('\n').filter(Boolean);
  expect(lines).toHaveLength(3);
  const item = JSON.parse(lines[1] ?? '{}') as { type?: string; length?: number };
  expect(item.type).toBe('event');
  expect(typeof item.length).toBe('number');
  const event = JSON.parse(lines[2] ?? '{}') as { level: string; tags: Record<string, string> };
  expect(event.level).toBe('error');
  expect(event.tags.quarantaine).toBe('4');
});

it('sends on an unhandled rejection, and stays silent without a DSN', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);

  const off = installErrorReporting({ dsn: '', environment: 'production' });
  window.dispatchEvent(new Event('error'));
  expect(fetchMock).not.toHaveBeenCalled();
  off();

  const stop = installErrorReporting({ dsn: 'https://abc123@glitch.nexenture.fr/5', environment: 'production' });
  stop.report({ message: 'sauvegarde interrompue', level: 'error', tags: { état: 'quarantined' } });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://glitch.nexenture.fr/api/5/envelope/');
  expect(String(init.headers && (init.headers as Record<string, string>)['X-Sentry-Auth'])).toContain('sentry_key=abc123');
  stop();
});
