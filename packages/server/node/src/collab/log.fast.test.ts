/**
 * The room log lines, against host-log-lines.json — the same fixture the Go,
 * C# and Rust hosts read. A doc id is attacker text, so an escape that slips
 * lets it forge a second record on a line of its own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { collabLogger, writeLogLine, type LogSink } from './log.ts';

interface LogLineCase {
  name: string;
  level: 'warning' | 'error';
  message: string;
  line: string;
}

const CASES = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../../test/unit/server-conformance/fixtures/host-log-lines.json', import.meta.url)),
  'utf8',
)) as LogLineCase[];

function sink(): LogSink & { written: string } {
  return {
    written: '',
    write(text: string) {
      this.written += text;
      return true;
    },
  };
}

describe('@fast collab log lines', () => {
  it.each(CASES)('escapes $name', ({ level, message, line }) => {
    const out = sink();

    writeLogLine(out, level, message);

    expect(out.written).toBe(line);
  });

  it('writes through the logger at the level it is given', () => {
    const out = sink();
    const log = collabLogger(out);

    log('collab: a warning', 'warning');
    log('collab: an error', 'error');

    expect(out.written).toBe('warning: collab: a warning\nerror: collab: an error\n');
  });
});
