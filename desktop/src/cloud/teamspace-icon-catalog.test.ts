import {describe, expect, it} from 'vitest';
import {teamspaceColors, teamspaceSymbols} from './teamspace-icon-catalog';

/**
 * Le catalogue est rendu en markup brut (`dangerouslySetInnerHTML`), donc un
 * nom d'icône mal orthographié n'échoue pas : il arrive `undefined` et la
 * case sort vide, sans la moindre erreur. D'où ces vérifications.
 */
describe('catalogue d’icônes', () => {
  it('offre un choix large, sans doublon de clé ni d’intitulé', () => {
    const keys = teamspaceSymbols.map(([key]) => key);
    const labels = teamspaceSymbols.map(([, label]) => label);

    expect(teamspaceSymbols.length).toBeGreaterThanOrEqual(90);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('ne garde que des dessins réellement exportés', () => {
    const empty = teamspaceSymbols
      .filter(([, , svg]) => typeof svg !== 'string' || !svg.includes('<svg'))
      .map(([key]) => key);

    expect(empty, `icônes sans dessin : ${empty.join(', ')}`).toEqual([]);
  });

  it('laisse chaque dessin prendre la couleur choisie', () => {
    // Un `fill` ou un `stroke` en dur ignorerait la palette : la case
    // resterait noire quelle que soit la couleur retenue.
    const fixed = teamspaceSymbols
      .filter(([, , svg]) => /(?:fill|stroke)="(?!none|currentColor)[^"]+"/.test(String(svg)))
      .map(([key]) => key);

    expect(fixed, `icônes à couleur figée : ${fixed.join(', ')}`).toEqual([]);
  });

  it('nomme chaque couleur de la palette', () => {
    expect(Object.values(teamspaceColors).every((color) => !!color.label && !!color.css)).toBe(true);
  });
});
