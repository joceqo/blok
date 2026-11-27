import { describe, it, expect } from 'vitest';
import { safeHttpHref, safePreviewSrc, safeFileDownloadHref } from '../../../../src/tools/file/url';

describe('safeHttpHref', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('returns null for the non-http(s) scheme %s', (url) => {
    expect(safeHttpHref(url)).toBeNull();
  });

  it('returns the normalized href for http and https', () => {
    expect(safeHttpHref('http://cdn/doc.pdf')).toBe('http://cdn/doc.pdf');
    expect(safeHttpHref('https://cdn/doc.pdf')).toBe('https://cdn/doc.pdf');
  });
});

describe('safePreviewSrc', () => {
  it('returns the normalized href for http and https', () => {
    expect(safePreviewSrc('https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
    expect(safePreviewSrc('http://example.com/a.pdf')).toBe('http://example.com/a.pdf');
  });

  it('allows blob: URLs from the default uploader', () => {
    expect(safePreviewSrc('blob:https://example.com/uuid')).toBe('blob:https://example.com/uuid');
  });

  it.each([
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'not a url',
    '',
  ])('returns null for the unsafe or invalid src %s', (url) => {
    expect(safePreviewSrc(url)).toBeNull();
  });
});

it('only offers inert imported bytes as downloads', () => {
  const data = 'data:application/octet-stream;base64,SGVsbG8=';
  expect(safeFileDownloadHref(data)).toBe(data);
  expect(safePreviewSrc(data)).toBeNull();
  expect(safeFileDownloadHref('data:application/octet-stream;base64,invalid!')).toBeNull();
  expect(safeFileDownloadHref('data:text/html;base64,SGVsbG8=')).toBeNull();
});
