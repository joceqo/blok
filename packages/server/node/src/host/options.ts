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
  // The four conformance-only collaboration switches. Only a conformance
  // build ever sets one: left out, each reads as "whatever this host does
  // standing", which is how a product host runs.
  /** POST /edit gives an insert the server's stamps and an update its credit. */
  collabStampAuthority?: boolean;
  /** Record notes are kept for the history routes to read an actor back off. */
  collabRecordNotes?: boolean;
  /** A restore is refused until the guards it trips are confirmed. */
  collabEnforceRestoreGuards?: boolean;
  /** A restore sends the pages it drops to the trash. */
  collabRestoreTrashesPages?: boolean;
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