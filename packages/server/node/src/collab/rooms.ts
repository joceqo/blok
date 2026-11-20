import type { CollabLog } from './log.ts';
import { DocEndpointClient, DocEndpointError } from './doc-endpoint.ts';

type RoomState =
  | { kind: 'idle' }
  | { kind: 'ready'; data: unknown; version: string | undefined }
  | { kind: 'failed' };

export class CollabRooms {
  private readonly client: DocEndpointClient;
  private readonly rooms = new Map<string, RoomState>();

  constructor(
    endpoint: string,
    authorization: string,
    private readonly log: CollabLog,
  ) {
    this.client = new DocEndpointClient({ endpoint, authorization });
  }

  async touchOnEdit(docId: string): Promise<void> {
    let state = this.rooms.get(docId) ?? { kind: 'idle' };
    if (state.kind === 'failed') {
      return;
    }
    if (state.kind === 'idle') {
      try {
        const loaded = await this.client.load(docId);
        const data = loaded.data === null ? { blocks: [] } : loaded.data;
        state = { kind: 'ready', data, version: loaded.version };
        this.rooms.set(docId, state);
      } catch (error) {
        this.rooms.set(docId, { kind: 'failed' });
        const message = error instanceof DocEndpointError || error instanceof Error
          ? error.message
          : String(error);
        this.log(`collab: room "${docId}" could not load: ${message}`, 'warning');
        return;
      }
    }
    if (state.kind !== 'ready') {
      return;
    }
    try {
      await this.client.save(docId, state.data, state.version);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`collab: room "${docId}" could not save: ${message}`, 'warning');
    }
  }
}