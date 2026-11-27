/**
 * HeaderUtilities.TryParseDate, the parser behind If-Modified-Since,
 * If-Unmodified-Since and If-Range. Ported from the Go host's
 * internal/dotnet/httpdate.go (and the Rust crates/dotnet/src/httpdate.rs);
 * test/unit/server-conformance/fixtures/http-dates.json is what all three
 * must answer. Date.parse is not a stand-in: it takes spellings .NET refuses
 * (lower case, "UTC", ISO) and reads a zone-less date as local time.
 */

/**
 * Microsoft.Net.Http.Headers.HttpRuleParser.DateFormats, tried in this order
 * with AllowWhiteSpaces | AssumeUniversal. TryStringToDate tries "r" first;
 * that fast path accepts a subset of the first entry here, to the same
 * instant, so it is left out.
 */
const DATE_FORMATS = [
  "ddd, d MMM yyyy H:m:s 'GMT'",
  'ddd, d MMM yyyy H:m:s',
  "d MMM yyyy H:m:s 'GMT'",
  'd MMM yyyy H:m:s',
  "ddd, d MMM yy H:m:s 'GMT'",
  'ddd, d MMM yy H:m:s',
  "d MMM yy H:m:s 'GMT'",
  'd MMM yy H:m:s',
  "dddd, d'-'MMM'-'yy H:m:s 'GMT'",
  "dddd, d'-'MMM'-'yy H:m:s",
  "ddd, d'-'MMM'-'yyyy H:m:s 'GMT'",
  'ddd MMM d H:m:s yyyy',
  'ddd, d MMM yyyy H:m:s zzz',
  'ddd, d MMM yyyy H:m:s',
  'd MMM yyyy H:m:s zzz',
  'd MMM yyyy H:m:s',
] as const;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** char.IsWhiteSpace: U+0085 counts, U+FEFF does not — unlike JavaScript's \s. */
function isWhite(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x09 && code <= 0x0d)
    || code === 0x20
    || code === 0x85
    || code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000;
}

/** __DTString: the index starts before the first character and pre-increments. */
class Cursor {
  private value: string[];
  private at = -1;

  constructor(value: string[]) {
    this.value = value;
  }

  get index(): number {
    return this.at;
  }

  get length(): number {
    return this.value.length;
  }

  next(): boolean {
    this.at += 1;
    return this.at < this.value.length;
  }

  char(): string {
    return this.value[this.at] ?? '';
  }

  /** __DTString.Match(char): a format space also takes NBSP or U+202F. */
  match(ch: string): boolean {
    this.at += 1;
    if (this.at >= this.value.length) {
      return false;
    }
    const here = this.value[this.at];
    if (here === ch || (ch === ' ' && (here === ' ' || here === ' '))) {
      return true;
    }
    this.at -= 1;
    return false;
  }

  skipWhite(): void {
    while (this.at + 1 < this.value.length && isWhite(this.value[this.at + 1] ?? '')) {
      this.at += 1;
    }
  }

  trimTail(): void {
    let end = this.value.length;
    while (end > 0 && isWhite(this.value[end - 1] ?? '')) {
      end -= 1;
    }
    this.value = this.value.slice(0, end);
  }

  repeatCount(): number {
    const ch = this.value[this.at];
    let to = this.at + 1;
    while (to < this.value.length && this.value[to] === ch) {
      to += 1;
    }
    const count = to - this.at;
    this.at = to - 1;
    return count;
  }

  /** DateTimeParse.ParseDigits(min, max): ASCII digits only. */
  digits(min: number, max: number): number | undefined {
    const start = this.at;
    let value = 0;
    let taken = 0;
    for (; taken < max; taken += 1) {
      this.at += 1;
      const ch = this.value[this.at];
      if (ch === undefined || ch < '0' || ch > '9') {
        this.at -= 1;
        break;
      }
      value = value * 10 + (ch.charCodeAt(0) - 0x30);
    }
    if (taken < min) {
      this.at = start;
      return undefined;
    }
    return value;
  }

  /** ParseDigits(digitLen): one means one or two digits. */
  digitLen(count: number): number | undefined {
    return count === 1 ? this.digits(1, 2) : this.digits(count, count);
  }

  /** The invariant fast path: three ASCII characters, folded with OR 0x20. */
  private threeLetters(names: string[]): number {
    if (!this.next() || this.value.length - this.at < 3) {
      return -1;
    }
    let key = '';
    for (let step = 0; step < 3; step += 1) {
      const ch = this.value[this.at + step] ?? '';
      const code = ch.codePointAt(0) ?? 0;
      if (code > 127) {
        return -1;
      }
      key += String.fromCharCode(code | 0x20);
    }
    return names.findIndex((name) => name.slice(0, 3) === key);
  }

  abbreviation(names: string[]): number | undefined {
    const index = this.threeLetters(names);
    if (index < 0) {
      return undefined;
    }
    this.at += 2;
    return index;
  }

  /**
   * MatchDayName: SetIfStartsWith compares OrdinalIgnoreCase, which folds
   * ASCII only here (.NET refuses "Tueſday", see http-dates.json).
   */
  dayName(): number | undefined {
    const index = this.threeLetters(DAYS);
    if (index < 0) {
      return undefined;
    }
    const name = DAY_NAMES[index] ?? '';
    if (this.value.length - this.at < name.length) {
      return undefined;
    }
    for (let step = 0; step < name.length; step += 1) {
      const code = (this.value[this.at + step] ?? '').codePointAt(0) ?? 0;
      if (code > 127 || String.fromCharCode(code | 0x20) !== name[step]) {
        return undefined;
      }
    }
    this.at += name.length - 1;
    return index;
  }

  /**
   * ParseTimeZoneOffset for "zzz": a sign, one or two hour digits, an optional
   * ':', then exactly two minute digits below 60. No inner spaces.
   */
  offset(): number | undefined {
    if (!this.next()) {
      return undefined;
    }
    const sign = this.char() === '+' ? 1 : this.char() === '-' ? -1 : 0;
    if (sign === 0) {
      return undefined;
    }
    const hours = this.digits(1, 2);
    if (hours === undefined) {
      return undefined;
    }
    this.match(':');
    const minutes = this.digits(2, 2);
    if (minutes === undefined || minutes >= 60) {
      return undefined;
    }
    return sign * (hours * 60 + minutes);
  }
}

const MIN_MS = utcMs(1, 1, 1, 0, 0, 0);
const MAX_MS = utcMs(9999, 12, 31, 23, 59, 59);

function utcMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0);
  // setUTCFullYear, not Date.UTC: that maps a year under 100 into the 1900s.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  offsetMinutes: number;
  twoDigitYear: boolean;
}

/** One format's pass over the input, as DateTimeParse.DoStrictParse runs it. */
function parseExact(input: string[], format: string[]): number | undefined {
  const text = new Cursor([...input]);
  const shape = new Cursor(format);
  const parts: Parts = {
    year: -1, month: -1, day: -1, hour: -1, minute: -1, second: -1,
    weekday: -1, offsetMinutes: 0, twoDigitYear: false,
  };

  text.trimTail();
  text.skipWhite();
  while (shape.next()) {
    text.skipWhite();
    if (!takeOne(shape, text, parts)) {
      return undefined;
    }
  }
  if (text.index < text.length - 1) {
    return undefined;
  }
  return assemble(parts);
}

function takeOne(shape: Cursor, text: Cursor, parts: Parts): boolean {
  const ch = shape.char();
  switch (ch) {
    case 'y': {
      const count = shape.repeatCount();
      parts.twoDigitYear = count <= 2;
      const year = text.digitLen(count);
      if (year === undefined) {
        return false;
      }
      parts.year = year;
      return true;
    }
    case 'M': {
      if (shape.repeatCount() !== 3) {
        return false;
      }
      const month = text.abbreviation(MONTHS);
      if (month === undefined) {
        return false;
      }
      parts.month = month + 1;
      return true;
    }
    case 'd': {
      const count = shape.repeatCount();
      if (count <= 2) {
        const day = text.digitLen(count);
        if (day === undefined) {
          return false;
        }
        parts.day = day;
        return true;
      }
      const weekday = count === 3 ? text.abbreviation(DAYS) : text.dayName();
      if (weekday === undefined) {
        return false;
      }
      parts.weekday = weekday;
      return true;
    }
    case 'H':
    case 'm':
    case 's': {
      const value = text.digitLen(Math.min(shape.repeatCount(), 2));
      if (value === undefined) {
        return false;
      }
      if (ch === 'H') {
        parts.hour = value;
      } else if (ch === 'm') {
        parts.minute = value;
      } else {
        parts.second = value;
      }
      return true;
    }
    case 'z': {
      if (shape.repeatCount() !== 3) {
        return false;
      }
      const offset = text.offset();
      if (offset === undefined) {
        return false;
      }
      parts.offsetMinutes = offset;
      return true;
    }
    case ':':
      return text.match(':');
    case "'": {
      while (shape.next() && shape.char() !== "'") {
        if (isWhite(shape.char())) {
          text.skipWhite();
        } else if (!text.match(shape.char())) {
          return false;
        }
      }
      return true;
    }
    default:
      return isWhite(ch) || text.match(ch);
  }
}

function assemble(parts: Parts): number | undefined {
  // The invariant calendar's TwoDigitYearMax is 2049.
  const year = parts.twoDigitYear ? parts.year + (parts.year > 49 ? 1900 : 2000) : parts.year;
  if (
    year < 1 || year > 9999 || parts.month < 1 || parts.month > 12 || parts.day < 1
    || parts.hour > 23 || parts.minute > 59 || parts.second > 59
  ) {
    return undefined;
  }
  const local = utcMs(year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  const stamped = new Date(local);
  if (stamped.getUTCDate() !== parts.day) {
    return undefined;
  }
  if (parts.weekday >= 0 && parts.weekday !== stamped.getUTCDay()) {
    return undefined;
  }
  if (parts.offsetMinutes < -14 * 60 || parts.offsetMinutes > 14 * 60) {
    return undefined;
  }
  const utc = local - parts.offsetMinutes * 60_000;
  return utc < MIN_MS || utc > MAX_MS ? undefined : utc;
}

/** The instant in milliseconds, or undefined when no format takes the text. */
export function parseHttpDate(value: string): number | undefined {
  if (value === '') {
    return undefined;
  }
  const input = [...value];
  for (const format of DATE_FORMATS) {
    const parsed = parseExact(input, [...format]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}
