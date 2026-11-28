import { describe, expect, it } from 'vitest';
import { chunkBlocks, CHUNK_TARGET } from './page-chunks.ts';

const block = (id: string | null, text: string) => ({ blockId: id, body: text });

describe('chunkBlocks', () => {
  it('keeps a short page in one chunk and remembers every block it covers', () => {
    const chunks = chunkBlocks([block('a', 'Le héron pêche.'), block('b', 'La marmotte dort.')]);

    expect(chunks).toEqual([{ index: 0, text: 'Le héron pêche.\nLa marmotte dort.', blockIds: ['a', 'b'], context: '' }]);
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

  it('preserves Unicode characters across a hard split', () => {
    const body = 'a'.repeat(CHUNK_TARGET - 1) + '🐢fin';
    const chunks = chunkBlocks([block('emoji', body)]);
    expect(chunks.map(chunk => Buffer.from(chunk.text).toString()).join('')).toBe(body);
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

    expect(chunks).toEqual([{ index: 0, text: 'Texte sans identifiant.', blockIds: [], context: '' }]);
  });
});

/**
 * A chunk embedded alone says nothing about where it comes from. "Il faut prévenir le service"
 * is unfindable; "Ressources humaines › Procédure de départ — Les démarches : il faut prévenir le
 * service" answers a question asked in someone else's words. The context is embedded with the
 * chunk and kept apart from it, so what the reader is shown stays the text that was written.
 */
describe('chunk context', () => {
  const page = ['Ressources humaines', 'Procédure de départ'];

  it('names the page and its ancestors on every chunk', () => {
    const chunks = chunkBlocks([block('a', 'Il faut prévenir le service.')], page);

    expect(chunks[0]!.context).toBe('Ressources humaines › Procédure de départ');
    // The text stays what was written: the context is for the vector, not for the reader.
    expect(chunks[0]!.text).toBe('Il faut prévenir le service.');
  });

  it('carries the heading a chunk sits under, and forgets it at the next one', () => {
    const chunks = chunkBlocks(
      [
        { blockId: 'h1', body: 'Les démarches', type: 'header' },
        { blockId: 'p1', body: 'x'.repeat(CHUNK_TARGET) },
        { blockId: 'h2', body: 'Le matériel', type: 'header' },
        { blockId: 'p2', body: 'y'.repeat(CHUNK_TARGET) },
      ],
      page,
    );

    expect(chunks.map(chunk => chunk.context)).toEqual([
      'Ressources humaines › Procédure de départ — Les démarches',
      'Ressources humaines › Procédure de départ — Les démarches',
      'Ressources humaines › Procédure de départ — Le matériel',
      'Ressources humaines › Procédure de départ — Le matériel',
    ]);
  });

  it('names the database a row belongs to, the way AFFiNE names it', () => {
    const chunks = chunkBlocks(
      [{ blockId: 'r1', body: 'Rendez-vous en mairie', type: 'database-row', parentName: 'Démarches' }],
      page,
    );

    expect(chunks[0]!.context).toBe('Ressources humaines › Procédure de départ — Démarches');
  });

  it('says nothing when there is nothing to say', () => {
    expect(chunkBlocks([block('a', 'Seul au monde.')], [])[0]!.context).toBe('');
  });
});
