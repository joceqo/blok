/**
 * A double written as .NET writes it, which `Utf8JsonWriter.WriteNumberValue`
 * and `ToString(InvariantCulture)` agree on — and which JS does not.
 *
 * The digits are the same on both sides: the shortest that read back as the
 * same double. What differs is when each one gives up on fixed notation. JS
 * holds out to 1e21 and 1e-7, .NET turns at 1e17 and 1e-5, so `1e17` is
 * `100000000000000000` in JS and `1E+17` in .NET. `-0` differs too: JS writes
 * `0`. Twenty-three of the fixture's fifty cases turn on exactly this, and a
 * digest taken over the JS spelling is wrong without ever looking wrong.
 */

/** Below this decimal exponent, and above the other, .NET writes d.dddE±XX. */
const FIXED_LOW = -4;
const FIXED_HIGH = 16;

export function formatDouble(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  // Object.is tells -0 from 0, which `< 0` cannot.
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const size = Math.abs(value);
  if (size === 0) return `${sign}0`;
  // Without a digit count, toExponential gives the shortest round-trip.
  const text = size.toExponential();
  const mark = text.indexOf('e');
  const digits = text.slice(0, mark).replace('.', '');
  const exponent = Number(text.slice(mark + 1));
  if (exponent < FIXED_LOW || exponent > FIXED_HIGH) {
    const head = digits.length > 1 ? `${digits.slice(0, 1)}.${digits.slice(1)}` : digits;
    const mark2 = exponent < 0 ? '-' : '+';
    return `${sign}${head}E${mark2}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  if (digits.length <= exponent + 1) {
    return `${sign}${digits}${'0'.repeat(exponent + 1 - digits.length)}`;
  }
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}
