import { describe, expect, it } from 'vitest';
import { chunkBlocks, CHUNK_TARGET } from './page-chunks.ts';

const block = (id: string | null, text: string) => ({ blockId: id, body: text });

describe('chunkBlocks', () => {
  it('keeps a short page in one chunk and remembers every block it covers', () => {
    const chunks = chunkBlocks([block('a', 'Le héron pêche.'), block('b', 'La marmotte dort.')]);

    expect(chunks).toEqual([{ index: 0, text: 'Le héron pêche.\nLa marmotte dort.', blockIds: ['a', 'b'] }]);
  });

  it('never cuts inside a block: a block that would overflow starts the next chunk', () => {
    const long = 'x'.repeat(Math.round(CHUNK_TARGET * 0.7));
    const chunks = chunkBlocks([block('a', long), block('b', long), block('c', 'court')]);

    expect(chunks.map(chunk => chunk.blockIds)).toEqual([['a'], ['b', 'c']]);
    expect(chunks[0]!.text).toBe(long);
  });

  it('splits a block larger than the target, and every piece still names that block', () => {
    const huge = 'mot '.repeat(CHUNK_TARGET); // bien au-delà de la cible
    const chunks = chunkBlocks([block('solo', huge)]);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(chunk => expect(chunk.blockIds).toEqual(['solo']));
    // Rien n'est perdu au découpage.
    expect(chunks.map(chunk => chunk.text).join('').replace(/\s+/g, ' ').trim())
      .toBe(huge.replace(/\s+/g, ' ').trim());
  });

  it('numbers chunks in reading order', () => {
    const long = 'y'.repeat(CHUNK_TARGET);
    const chunks = chunkBlocks([block('a', long), block('b', long), block('c', long)]);

    expect(chunks.map(chunk => chunk.index)).toEqual([0, 1, 2]);
  });

  it('drops blocks with nothing to read, and a page with no text yields no chunk', () => {
    expect(chunkBlocks([block('a', '   '), block('b', '')])).toEqual([]);
    expect(chunkBlocks([])).toEqual([]);
  });

  it('keeps a block that has no id: its text is still searchable, it just cites nothing', () => {
    const chunks = chunkBlocks([block(null, 'Texte sans identifiant.')]);

    expect(chunks).toEqual([{ index: 0, text: 'Texte sans identifiant.', blockIds: [] }]);
  });
});
