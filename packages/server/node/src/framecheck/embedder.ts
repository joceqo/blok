import { equalsOrdinalIgnoreCase } from '../dotnet/ordinal.ts';

export interface FrameCheckRequest {
  origin: string;
  hasOrigin: boolean;
  secFetchSite: string;
  embedder: string;
  self: string;
}

export function chooseEmbedder(request: FrameCheckRequest, allowed: (origin: string) => boolean): string {
  if (request.hasOrigin) {
    return allowed(request.origin) ? request.origin : '';
  }
  if (
    request.self !== ''
    && equalsOrdinalIgnoreCase(request.secFetchSite, 'same-origin')
    && equalsOrdinalIgnoreCase(request.embedder, request.self)
  ) {
    return request.embedder;
  }
  if (allowed(request.embedder)) {
    return request.embedder;
  }
  return '';
}