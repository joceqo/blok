/**
 * Un document devient des morceaux à plonger dans l'index vectoriel.
 *
 * Le texte vient du SQL (`pageBlockText`), une ligne par bloc : il n'existe qu'un seul extracteur,
 * donc l'index et la recherche lisent le document de la même façon. Ici on ne fait que regrouper.
 *
 * Les frontières sont celles des blocs, jamais le milieu d'une phrase : un morceau qui chevauche
 * deux blocs sait les nommer tous les deux, et c'est ce qui permet de citer un bloc plutôt qu'une
 * page. Un bloc plus long que la cible est l'exception — un bloc de code, une note collée — et il
 * est alors coupé en gardant son identifiant sur chaque morceau.
 */

/** Taille visée d'un morceau, en caractères. Assez large pour garder un raisonnement, assez court pour rester précis. */
export const CHUNK_TARGET = 1000;

export interface BlockText {
  /** `null` quand le bloc a été enregistré sans identifiant : lisible, mais non citable. */
  blockId: string | null;
  body: string;
}

export interface PageChunk {
  index: number;
  text: string;
  /** Les blocs couverts, dans l'ordre de lecture. Vide quand aucun n'était citable. */
  blockIds: string[];
}

/** Coupe un texte trop long sur un blanc, pour ne pas trancher un mot en deux. */
const cutPieces = (text: string): string[] => {
  const pieces: string[] = [];
  let rest = text;

  while (rest.length > CHUNK_TARGET) {
    const window = rest.slice(0, CHUNK_TARGET);
    const space = window.lastIndexOf(' ');
    // Un texte sans aucun blanc — une longue URL, un identifiant — se coupe net.
    const at = space > CHUNK_TARGET / 2 ? space + 1 : CHUNK_TARGET;

    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest !== '') pieces.push(rest);

  return pieces;
};

export function chunkBlocks(blocks: readonly BlockText[]): PageChunk[] {
  const chunks: PageChunk[] = [];
  let buffer = '';
  let ids: string[] = [];

  const flush = (): void => {
    if (buffer === '') return;
    chunks.push({ index: chunks.length, text: buffer, blockIds: ids });
    buffer = '';
    ids = [];
  };

  for (const { blockId, body } of blocks) {
    const text = body.trim();

    if (text === '') continue;

    if (text.length > CHUNK_TARGET) {
      flush();
      for (const piece of cutPieces(text)) {
        chunks.push({ index: chunks.length, text: piece, blockIds: blockId === null ? [] : [blockId] });
      }
      continue;
    }
    // Ce bloc ferait déborder le morceau en cours : il ouvre le suivant, entier.
    if (buffer !== '' && buffer.length + 1 + text.length > CHUNK_TARGET) flush();
    buffer = buffer === '' ? text : `${buffer}\n${text}`;
    if (blockId !== null) ids.push(blockId);
  }
  flush();

  return chunks;
}
