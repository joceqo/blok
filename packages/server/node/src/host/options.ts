import type { BlobStore } from '../blob/store.ts';
import type { CollabLog } from '../collab/log.ts';
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
  collabDirectory: string;
  collabJournal: boolean;
  /**
   * Keep-alive period on a sync socket, in milliseconds; 0 leaves the probe to
   * the room's own heartbeat. Only a conformance build sets it.
   */
  collabKeepAliveMs?: number;
  collabS3Prefix: string;
  docEndpoint: string;
  docEndpointAuth: string;
  collabLog: CollabLog;
  allowedOrigins: string[];
  fileBytesEnabled: boolean;
  fileBytesMaxBytes: number;
  filesCors: boolean;
  fetcher: OutboundFetcher;
  rateLimiter: RateLimiter;
  rateLimitPerMinute: number;
  loopbackHostCheck: boolean;
  allowedHostNames: string[];
  blobStore?: BlobStore;
}