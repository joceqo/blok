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
  /** Le type du bloc. Un titre devient le contexte de ce qui le suit. */
  type?: string | null;
  /** Le nom du bloc qui contient celui-ci — la base de données d'une ligne. */
  parentName?: string | null;
}

export interface PageChunk {
  index: number;
  text: string;
  /** Les blocs couverts, dans l'ordre de lecture. Vide quand aucun n'était citable. */
  blockIds: string[];
  /**
   * D'où vient ce morceau : le fil des pages, puis le titre de section ou la base parente.
   *
   * Plongé avec le texte, gardé à part de lui. Un passage embarqué seul ne dit pas de quoi il
   * parle — « il faut prévenir le service » ne répond à aucune question posée avec d'autres mots.
   * C'est le *contextual retrieval* : la même page découpée, mais chaque morceau sait où il est.
   * Le texte montré au lecteur, lui, reste celui qui a été écrit.
   */
  context: string;
}

/** Le fil des pages, puis ce qui situe le morceau dans la page. */
const contextLine = (path: readonly string[], within: string): string => {
  const trail = path.map(name => name.trim()).filter(name => name !== '').join(' › ');

  return within === '' ? trail : trail === '' ? within : `${trail} — ${within}`;
};

/** Un bloc qui coiffe ce qui le suit. Le type exact vient des outils, pas d'ici. */
const isHeading = (type: string | null | undefined): boolean => type === 'header';

/** Coupe un texte trop long sur un blanc, pour ne pas trancher un mot en deux. */
const cutPieces = (text: string): string[] => {
  const pieces: string[] = [];
  let rest = text;

  while (rest.length > CHUNK_TARGET) {
    const window = rest.slice(0, CHUNK_TARGET);
    const space = window.lastIndexOf(' ');
    // Un texte sans aucun blanc — une longue URL, un identifiant — se coupe net.
    let at = space > CHUNK_TARGET / 2 ? space + 1 : CHUNK_TARGET;
    // JSONB rejects an isolated UTF-16 surrogate in a stored chunk.
    const last = rest.charCodeAt(at - 1);
    if (last >= 0xd800 && last <= 0xdbff) at--;

    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest !== '') pieces.push(rest);

  return pieces;
};

/**
 * @param blocks Le texte du document, un élément par bloc, dans l'ordre de lecture.
 * @param path Le fil des pages jusqu'à celle-ci, la sienne en dernier.
 */
export function chunkBlocks(blocks: readonly BlockText[], path: readonly string[] = []): PageChunk[] {
  const chunks: PageChunk[] = [];
  let buffer = '';
  let ids: string[] = [];
  // Le dernier titre rencontré. Il coiffe ce qui le suit jusqu'au titre suivant.
  let heading = '';
  // Le contexte du morceau en cours. Un morceau n'en porte qu'un : il annonce d'où vient son
  // texte, donc il ne peut pas chevaucher deux endroits de la page sans mentir sur l'un des deux.
  let context = '';

  const flush = (): void => {
    if (buffer === '') return;
    chunks.push({ index: chunks.length, text: buffer, blockIds: ids, context: contextLine(path, context) });
    buffer = '';
    ids = [];
  };

  for (const { blockId, body, type, parentName } of blocks) {
    const text = body.trim();

    if (text === '') continue;
    // Un titre se range sous lui-même : il annonce la section dont il est la première ligne.
    if (isHeading(type)) heading = text;
    const held = parentName === null || parentName === undefined ? '' : parentName.trim();
    const here = held === '' ? heading : held;

    if (here !== context) {
      flush();
      context = here;
    }

    if (text.length > CHUNK_TARGET) {
      flush();
      for (const piece of cutPieces(text)) {
        chunks.push({
          index: chunks.length,
          text: piece,
          blockIds: blockId === null ? [] : [blockId],
          context: contextLine(path, context),
        });
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
