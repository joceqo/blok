// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJson, contentRevision } from '../../../src/shared/agent/revision';

afterEach(() => vi.unstubAllGlobals());

it('uses the server hash accelerator on the same canonical text as the portable implementation', () => {
  const document = { blocks: [{ id: 'p', type: 'paragraph', data: { text: 'été 🏢 \ud800', z: 1, a: true } }] };
  const portable = contentRevision(document);
  const hash = vi.fn(() => portable.slice(1));
  vi.stubGlobal('__blokCyrb53', hash);
  expect(contentRevision(document)).toBe(portable);
  expect(hash).toHaveBeenCalledExactlyOnceWith(canonicalJson(document));
});

it('keeps portable revisions when the host has no accelerator', () => {
  const document = { blocks: [{ id: 'p', type: 'paragraph', data: { text: 'hello' } }] };
  const original = contentRevision(document);
  vi.stubGlobal('__blokCyrb53', undefined);
  expect(contentRevision(document)).toBe(original);
  expect(contentRevision({ blocks: [{ ...document.blocks[0], data: { text: 'changed' } }] })).not.toBe(original);
});
