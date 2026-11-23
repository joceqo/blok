import {OutputData} from '../data-formats/output-data';

/**
 * Describes Blok`s saver API
 */
export interface QuarantineReview {
  /** Highest quarantine key included in this review. */
  through: number;
  entries: Array<{ reason: string; count: number }>;
  /** Readable contents of the most recent available recovery copy. */
  preview?: string;
}

export interface Saver {
  inspectQuarantine(): Promise<QuarantineReview>;
  /** Discard only the reviewed rows, after confirmation. */
  clearQuarantine(through: number): Promise<number>;
  /**
   * Saves Blok's data and returns promise with it
   *
   * @returns {Promise<OutputData>}
   */
  save(): Promise<OutputData>;
  /** Flush pending editor writes and, during collaboration, wait for the server's
   * durable acknowledgement. Rejects on timeout or lost/quarantined work.
   * Local mode flushes the document only; host persistence remains its owner's job. */
  flush(timeoutMs?: number): Promise<void>;
}
