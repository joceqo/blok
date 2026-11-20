export interface HostAppOptions {
  version: string;
  unfurlDisabled: boolean;
  unfurlEnabled: boolean;
  storageDirectory: string;
  publicPath: string;
  collabEnabled: boolean;
  docEndpoint: string;
  allowedOrigins: string[];
}