import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * L'anneau de focus du shell est discret et neutre, jamais un trait bleu vif
 * (USER, 2026-11-27 : « juste thoses accessibility lines »). Le bleu venait de
 * deux sources qu'il faut fermer ensemble — un `--blok-focus-ring: #2e8cff`
 * posé sur le shell, et un `#2383e2` de repli recopié dans vingt-six règles —
 * donc n'en corriger qu'une le laisse revenir par l'autre. Le reste du bleu de
 * l'application (interrupteurs, pastilles, liens) n'est pas concerné.
 */
const root = join(process.cwd(), 'src');
const sheets = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.css'))
  .map((path) => ({ path, css: readFileSync(join(root, path), 'utf8') }));

/** Bleu : un canal bleu qui domine nettement les deux autres. */
export function isBlue(literal: string): boolean {
  const hex = literal.slice(1);
  const wide = hex.length === 6;
  const channel = (index: number): number =>
    wide ? parseInt(hex.slice(index * 2, index * 2 + 2), 16) : parseInt(hex[index].repeat(2), 16);
  const [red, green, blue] = [channel(0), channel(1), channel(2)];

  return blue - red > 24 && blue - green > 24;
}

/** Corps des règles dont le sélecteur porte un état de focus. */
function focusRules(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => /:focus(-visible|-within)?\b/.test(rule[1]))
    .map((rule) => rule[2]);
}

/**
 * Seuls les traits comptent. Une règle de focus peut parfaitement teinter du
 * texte en bleu — c'est l'anneau posé par-dessus la rangée que l'utilisateur
 * ne veut plus voir, donc on ne lit que `outline` et `box-shadow`.
 */
const ringLiterals = (body: string): string[] =>
  body
    .split(';')
    .filter((declaration) => /^\s*(outline|box-shadow)\b/.test(declaration))
    .flatMap((declaration) => [...declaration.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)])
    .map((match) => match[0]);

describe('anneau de focus du shell', () => {
  it('lit bien le bleu et laisse passer le neutre', () => {
    expect(['#2383e2', '#2e8cff', '#3988df', '#4c9fff'].every(isBlue)).toBe(true);
    expect(['#ececec', '#242424', '#a2a2a2', '#fff', '#c75045'].some(isBlue)).toBe(false);
  });

  it('trouve bien des feuilles à inspecter', () => {
    expect(sheets.length).toBeGreaterThan(20);
  });

  it('ne peint aucun état de focus en bleu', () => {
    const blues = sheets.flatMap(({ path, css }) =>
      focusRules(css)
        .flatMap(ringLiterals)
        .filter(isBlue)
        .map((color) => `${path}: ${color}`));

    expect(blues, `focus peint en bleu : ${blues.join(', ')}`).toEqual([]);
  });

  it('définit un anneau de focus discret dérivé des gris du shell', () => {
    const shell = sheets.find((sheet) => sheet.path === 'shell.css')?.css ?? '';

    expect(shell).toMatch(/--desktop-focus-ring:\s*var\(--desktop-muted\)/);
  });

  /**
   * Une propriété personnalisée substitue son `var()` là où elle est déclarée,
   * pas là où elle est lue : un anneau défini une seule fois sur `:root` garde
   * le gris du thème sombre et tombe à 2,6:1 sur le fond blanc du thème clair.
   * Chaque bloc qui redéfinit l'encre secondaire redéfinit donc l'anneau.
   */
  it('redonne l’anneau à chaque thème qui redéfinit le gris', () => {
    const shell = sheets.find((sheet) => sheet.path === 'shell.css')?.css ?? '';
    const orphans = [...shell.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => /--desktop-muted:/.test(rule[2]) && !/--desktop-focus-ring:/.test(rule[2]))
      .map((rule) => rule[1].trim());

    expect(orphans, `thème sans anneau propre : ${orphans.join(' | ')}`).toEqual([]);
  });
});
