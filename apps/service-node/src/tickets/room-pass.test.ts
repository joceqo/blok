import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { roomPass } from './room-pass.ts';

const key = 'g'.repeat(32);
function signed(json: string) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const input = header + '.' + Buffer.from(json).toString('base64url');
  return input + '.' + createHmac('sha256', key).update(input).digest('base64url');
}

describe('Go-compatible room admission pass', () => {
  const claims = '"user":"a","doc":"p","write":false';
  it('checks expiry at its exact Unix second and binds the document', () => {
    const ticket = signed('{' + claims + ',"exp":100}');
    expect(roomPass(key, ticket, 'p', 99999)).toEqual({ user: 'a', write: false });
    expect(roomPass(key, ticket, 'other', 99999)).toBeUndefined();
    expect(roomPass(key, ticket, 'p', 100000)).toBeUndefined();
  });
  it('uses raw signed integers and type-checks repeated claims like Go', () => {
    for (const invalid of ['100.0', '1e2', '9223372036854775808', '-9223372036854775809', '"100"']) {
      expect(roomPass(key, signed('{' + claims + ',"exp":' + invalid + '}'), 'p', 0)).toBeUndefined();
    }
    expect(roomPass(key, signed('{' + claims + ',"exp":9223372036854775807}'), 'p', 0)).toEqual({
      user: 'a',
      write: false,
    });
    expect(roomPass(key, signed('{"write":1,' + claims + ',"exp":100}'), 'p', 0)).toBeUndefined();
    expect(roomPass(key, signed('{' + claims + ',"write":true,"exp":100}'), 'p', 0)).toEqual({
      user: 'a',
      write: true,
    });
  });
});
