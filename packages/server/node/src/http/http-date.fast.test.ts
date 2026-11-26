/**
 * http-dates.json holds what HeaderUtilities.TryParseDate answers; the C#
 * HttpDateFixtureTests recomputes it, and the Go and Rust hosts read the same
 * file. Node must answer the same or its preconditions drift from the others.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseHttpDate } from './http-date.ts';

interface Fixture {
  answers: Array<number | null>;
  inputs: string[];
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL(
    '../../../../../test/unit/server-conformance/fixtures/http-dates.json',
    import.meta.url,
  )),
  'utf8',
)) as Fixture;

describe('parseHttpDate', () => {
  it('answers what HeaderUtilities.TryParseDate answers', () => {
    expect(fixture.inputs.length).toBe(fixture.answers.length);
    expect(fixture.inputs.length).toBeGreaterThan(0);

    const wrong = fixture.inputs.flatMap((input, index) => {
      const parsed = parseHttpDate(input);
      const seconds = parsed === undefined ? null : Math.floor(parsed / 1000);

      return seconds === fixture.answers[index]
        ? []
        : [{ input, got: seconds, want: fixture.answers[index] ?? null }];
    });

    expect(wrong).toEqual([]);
  });
});
