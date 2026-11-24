export interface ChangePoint {
  lineage: string;
  sequence: number;
  committedAt: number;
}

export const maxHistoryChangeRecords = 200;
const maxResponseBytes = 4 * 1024 * 1024;

// Replay runs oldest first. Retain the newest rows that fit, including the
// property breakdown and agent notes. A single large edit must remain readable.
export class HistoryChangeWindow {
  private rows: Array<{ point: ChangePoint; value: object; bytes: number }> = [];
  private bytes = 0;
  private cut = false;

  add(point: ChangePoint, value: object) {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    this.rows.push({ point, value, bytes });
    this.bytes += bytes;
    while (this.rows.length > 1 && this.bytes > maxResponseBytes) this.dropOldest();
  }

  private dropOldest() {
    this.bytes -= this.rows.shift()!.bytes;
    this.cut = true;
  }

  result(older: ChangePoint | undefined, newestFirst: boolean) {
    // When only a block filter hid older rows, continue from the oldest
    // record examined. When rows were dropped for size, continue at the cut.
    const envelope = () => {
      const olderEnd = this.cut ? this.rows[0]!.point : older;
      return { changes: [] as object[], truncated: !!olderEnd, ...(olderEnd && { olderEnd }) };
    };
    let body = envelope();
    while (
      this.rows.length > 1 &&
      this.bytes - 1 + Buffer.byteLength(JSON.stringify(body)) > maxResponseBytes
    ) {
      this.dropOldest();
      body = envelope();
    }
    body.changes = this.rows.map((row) => row.value);
    if (newestFirst) body.changes.reverse();
    return body;
  }
}
