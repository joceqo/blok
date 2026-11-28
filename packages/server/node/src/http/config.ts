import type { BodyRate } from './body.ts';

/** The host's limits. Defaults match Kestrel / the Go host. */
export interface Config {
  headerTimeoutMs: number;
  keepAliveTimeoutMs: number;
  requestTimeoutMs: number | undefined;
  maxRequestBody: number;
  minBodyRate: BodyRate | undefined;
  serverHeader: string | undefined;
}

export function defaultConfig(): Config {
  return {
    headerTimeoutMs: 10_000,
    keepAliveTimeoutMs: 120_000,
    requestTimeoutMs: 600_000,
    maxRequestBody: 30_000_000,
    minBodyRate: {
      bytesPerSecond: 240,
      graceMs: 5_000,
    },
    serverHeader: 'Kestrel',
  };
}