import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MIN_LIST_LIMIT,
  clampListLimit,
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  parseListPagination,
} from '@/http/pagination.js';

describe('parseListPagination', () => {
  it('is not paginated when limit and cursor are absent', () => {
    expect(parseListPagination(new URLSearchParams())).toEqual({
      paginated: false,
      limit: DEFAULT_LIST_LIMIT,
      cursor: undefined,
    });
  });

  it('is paginated when only limit is present', () => {
    expect(parseListPagination(new URLSearchParams('limit=25'))).toEqual({
      paginated: true,
      limit: 25,
      cursor: undefined,
    });
  });

  it('is paginated when only cursor is present', () => {
    expect(parseListPagination(new URLSearchParams('cursor=abc'))).toEqual({
      paginated: true,
      limit: DEFAULT_LIST_LIMIT,
      cursor: 'abc',
    });
  });

  it('uses a custom default limit when limit is absent but paginated', () => {
    expect(parseListPagination(new URLSearchParams('cursor=abc'), 50)).toEqual({
      paginated: true,
      limit: 50,
      cursor: 'abc',
    });
  });

  it('parses both limit and cursor together', () => {
    expect(parseListPagination(new URLSearchParams('limit=10&cursor=xyz'))).toEqual({
      paginated: true,
      limit: 10,
      cursor: 'xyz',
    });
  });
});

describe('clampListLimit', () => {
  it('returns undefined for missing or non-numeric values', () => {
    expect(clampListLimit(undefined)).toBeUndefined();
    expect(clampListLimit('')).toBeUndefined();
    expect(clampListLimit('nope')).toBeUndefined();
  });

  it('clamps to 1–100', () => {
    expect(clampListLimit('0')).toBe(MIN_LIST_LIMIT);
    expect(clampListLimit('-5')).toBe(MIN_LIST_LIMIT);
    expect(clampListLimit('1')).toBe(1);
    expect(clampListLimit('100')).toBe(100);
    expect(clampListLimit('101')).toBe(MAX_LIST_LIMIT);
    expect(clampListLimit('999')).toBe(MAX_LIST_LIMIT);
  });

  it('truncates fractional numbers', () => {
    expect(clampListLimit('12.9')).toBe(12);
  });
});

describe('time+id cursors', () => {
  it('round-trips createdAt and id', () => {
    const at = new Date('2024-06-01T12:00:00.000Z');
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const cursor = encodeTimeIdCursor(at, id);
    expect(decodeTimeIdCursor(cursor)).toEqual({ at, id });
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeTimeIdCursor('not-base64!!!')).toThrow();
  });
});