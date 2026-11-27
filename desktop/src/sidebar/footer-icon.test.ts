import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, expect, it } from 'vitest';
import { FooterIcon } from './footer-icon';
import { footerIconPaths } from '../components/shell/footer-icon-paths';

let container: HTMLDivElement | undefined;
afterEach(() => { container?.remove(); container = undefined; });

function render(name: Parameters<typeof FooterIcon>[0]['name']): SVGPathElement {
  container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(FooterIcon, { name })));
  const path = container.querySelector('path');
  if (!path) throw new Error('no path rendered');
  return path;
}

it('rounds the caps so a dot drawn as a hairline segment still shows', () => {
  // « h.01 » dessine un point : sans bout rond il ne reste qu'un trait de 0,01
  // de large. C'est le point du point d'interrogation et les yeux de l'émoji.
  expect(render('help').getAttribute('stroke-linecap')).toBe('round');
  expect(footerIconPaths.help).toContain('h.01');
  expect(footerIconPaths.emoji).toContain('h.01');
});

it('draws the help circle on the same ring as its neighbours', () => {
  const ring = (path: string) => /a(\d+(?:\.\d+)?) \1 0/.exec(path)?.[1];
  expect(ring(footerIconPaths.help)).toBe(ring(footerIconPaths.emoji));
});
