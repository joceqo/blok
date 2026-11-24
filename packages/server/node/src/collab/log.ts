const NEWLINE = process.platform === 'win32' ? '\r\n' : '\n';

/** Writes "<kind>: <message>" with collab log escaping (host-log-lines.json). */
export function writeLogLine(
  out: NodeJS.WriteStream,
  kind: 'warning' | 'error',
  message: string,
): void {
  let line = `${kind}: `;
  for (let i = 0; i < message.length;) {
    const code = message.charCodeAt(i);
    if (code === 0x0a) {
      line += '\\n';
      i += 1;
      continue;
    }
    if (code === 0x0d) {
      line += '\\r';
      i += 1;
      continue;
    }
    if (code === 0x09) {
      line += '\\t';
      i += 1;
      continue;
    }
    if (
      (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
    ) {
      line += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
      i += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = message.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        line += message[i]! + message[i + 1]!;
        i += 2;
        continue;
      }
    }
    line += message[i]!;
    i += 1;
  }
  out.write(line);
  out.write(NEWLINE);
}

export type CollabLog = (message: string, level: 'warning' | 'error') => void;

export function collabLogger(out: NodeJS.WriteStream): CollabLog {
  return (message, level) => {
    writeLogLine(out, level, message);
  };
}