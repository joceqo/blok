/**
 * Whether the editor is busy mounting a document, and a way to be told when it
 * is done.
 *
 * Mounting a page fills the block tree one slice at a time, so anything that
 * reacts to a block rendering sees the document part-built — a linked database
 * view redrew itself from its source 34 times on one load, once per state the
 * source passed through on its way to being complete, each one a full rebuild
 * of the DOM. None of those states was worth drawing; only the last one is.
 *
 * Deliberately not a timer. The renders are spread over seconds rather than
 * packed into a frame, so folding them on a frame or an idle deadline either
 * fires mid-mount or never — both were tried and measured, and both made the
 * load slower than doing nothing. What ends the burst is the mount ending, so
 * that is what this reports.
 */

/** How many mounts are in flight; nested batches must not end each other's. */
let depth = 0;

/** Who to tell when the outermost mount ends. */
let waiting: Array<() => void> = [];

/** Whether a document is being mounted right now. */
export const isDocumentMounting = (): boolean => depth > 0;

/** Marks the start of a mount. Always pair with `endDocumentMount`. */
export const beginDocumentMount = (): void => {
  depth += 1;
};

/**
 * Marks the end of a mount, and runs what was waiting once the outermost one
 * finishes. An extra call is a no-op rather than a negative depth, so a failed
 * mount cannot leave the editor permanently "done".
 */
export const endDocumentMount = (): void => {
  if (depth === 0) {
    return;
  }
  depth -= 1;
  if (depth > 0) {
    return;
  }

  // Taken before the first callback runs: one of them may subscribe again,
  // and that subscription belongs to the next mount, not to this drain.
  const due = waiting;

  waiting = [];
  for (const run of due) {
    try {
      run();
    } catch (error) {
      // One subscriber's failure must not strand the others.
      console.error('[blok] un abonné à la fin du montage a échoué', error);
    }
  }
};

/**
 * Runs `callback` once the current mount ends — or straight away when no mount
 * is in flight, so a caller never waits for a mount that will not come.
 * @param callback - what to run when the document is fully mounted
 */
export const onDocumentMounted = (callback: () => void): void => {
  if (depth === 0) {
    callback();

    return;
  }
  waiting.push(callback);
};
