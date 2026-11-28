/** JSON wire shape for a workspace asset row (bigint byteSize → string). */
export function toAssetJson(asset: {
  id: string;
  workspaceId: string;
  storageKey: string;
  byteSize: bigint;
  createdAt: Date;
}): {
  id: string;
  workspaceId: string;
  storageKey: string;
  byteSize: string;
  createdAt: Date;
} {
  return {
    id: asset.id,
    workspaceId: asset.workspaceId,
    storageKey: asset.storageKey,
    byteSize: asset.byteSize.toString(),
    createdAt: asset.createdAt,
  };
}