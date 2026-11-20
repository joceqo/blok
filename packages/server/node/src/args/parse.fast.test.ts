import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseHostArguments } from './parse.ts';

const okArgs = z.object({
  err: z.literal(''),
  help: z.literal(false),
  listen: z.string().min(1),
  rateLimitPerMinute: z.int().nonnegative(),
});

describe('@fast parseHostArguments', () => {
  it('accepts defaults and satisfies the config schema', () => {
    const parsed = parseHostArguments([], false);
    expect(okArgs.safeParse(parsed).success).toBe(true);
    expect(parsed.listen).toContain(':');
  });

  it('rejects a bad bool flag value', () => {
    const parsed = parseHostArguments(['--no-unfurl=maybe'], false);
    expect(parsed.err).toContain('invalid value "maybe"');
  });

  it('splits allow-origin into a string array', () => {
    const parsed = parseHostArguments(['--allow-origin', 'https://a.test,https://b.test'], false);
    expect(parsed.err).toBe('');
    expect(parsed.allowedOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('rejects rich-text fields with a repeated key', () => {
    const parsed = parseHostArguments(['--rich-text-fields', '{"a":["x"],"a":["y"]}'], false);
    expect(parsed.err).toContain('invalid value');
    expect(parsed.err).toContain('rich-text-fields');
  });
});