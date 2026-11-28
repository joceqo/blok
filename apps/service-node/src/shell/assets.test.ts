import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assetKey, verifyAssetGrant } from './assets.ts';
import { decodeWorkspaceImage } from './workspace-media.ts';

describe('canonical private assets', () => {
  const name = 'a'.repeat(32) + '.png',
    base = 'https://blok.test';
  it('accepts names emitted by the existing store only on this server', () => {
    expect(assetKey('/files/' + name, base)).toBe(name);
    for (const value of [
      'https://other.test/files/' + name,
      '//other.test/files/' + name,
      '/files/a%2F' + name,
      '/files/nested/' + name,
      '/foo/' + name,
    ])
      expect(assetKey(value, base)).toBeUndefined();
  });
  it('validates existing HMAC grants across process restarts and binds all fields', () => {
    const session = '0'.repeat(64);
    const signature = createHmac('sha256', 'secret')
      .update(session + '\n' + name + '\n1060')
      .digest('base64url');
    const query = new URLSearchParams({ session, expires: '1060', grant: signature });
    expect(verifyAssetGrant(query, 'secret', name, 1000)).toBe(session);
    for (const now of [994, 1061]) expect(verifyAssetGrant(query, 'secret', name, now)).toBeUndefined();
    expect(verifyAssetGrant(query, 'other', name, 1000)).toBeUndefined();
    expect(verifyAssetGrant(query, 'secret', 'other', 1000)).toBeUndefined();
  });
  it('requires size, MIME and contents to agree for workspace images', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    expect(decodeWorkspaceImage('data:image/png;base64,' + png.toString('base64')).bytes).toEqual(png);
    for (const raw of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png;base64,YQ==',
      'data:image/jpeg;base64,' + png.toString('base64'),
    ])
      expect(() => decodeWorkspaceImage(raw)).toThrow();
    expect(() => decodeWorkspaceImage('data:image/png;base64,' + png.toString('base64'), 4)).toThrow();
  });
});
