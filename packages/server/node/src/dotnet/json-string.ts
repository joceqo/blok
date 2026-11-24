/** System.Text.Json-style quoting: non-ASCII becomes \\uXXXX (UTF-16 code units). */
export function escapeJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x26:
        out += '\\u0026';
        break;
      case 0x3c:
        out += '\\u003C';
        break;
      case 0x3e:
        out += '\\u003E';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      case 0x08:
        out += '\\b';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0d:
        out += '\\r';
        break;
      case 0x09:
        out += '\\t';
        break;
      default:
        if (c < 0x20 || c >= 0x7f) {
          out += `\\u${c.toString(16).padStart(4, '0').toUpperCase()}`;
        } else {
          out += value[i];
        }
    }
  }
  return `${out}"`;
}