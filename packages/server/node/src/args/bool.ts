/** Hand port of Go/C# strconv.ParseBool / TryParseBoolean. */
export function parseBool(value: string): boolean | undefined {
  switch (value) {
    case '1':
    case 't':
    case 'T':
    case 'TRUE':
    case 'true':
    case 'True':
      return true;
    case '0':
    case 'f':
    case 'F':
    case 'FALSE':
    case 'false':
    case 'False':
      return false;
    default:
      return undefined;
  }
}