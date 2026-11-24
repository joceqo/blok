/** JSON wire shape for a workspace_images row (bigint byteSize → string). */
export function toWorkspaceImageJson(image: {
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
    id: image.id,
    workspaceId: image.workspaceId,
    storageKey: image.storageKey,
    byteSize: image.byteSize.toString(),
    createdAt: image.createdAt,
  };
}