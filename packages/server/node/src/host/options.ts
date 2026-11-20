import type { OutboundFetcher } from '../outbound/fetcher.ts';
import { RateLimiter } from './rate-limit.ts';

export interface HostAppOptions {
  version: string;
  auth: string;
  secret: string;
  unfurlDisabled: boolean;
  unfurlEnabled: boolean;
  storageDirectory: string;
  publicPath: string;
  publicUrl: string;
  maxUploadBytes: number;
  collabEnabled: boolean;
  docEndpoint: string;
  allowedOrigins: string[];
  fileBytesEnabled: boolean;
  fileBytesMaxBytes: number;
  filesCors: boolean;
  fetcher: OutboundFetcher;
  rateLimiter: RateLimiter;
}