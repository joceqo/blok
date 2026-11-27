import {useLayoutEffect, useRef} from 'react';
import {renderPageIcon} from '../../../src/shell/page-icon';

const PAGE_GLYPH = ['M4 2.5h5.2L12.5 6v7.5H4z', 'M9.2 2.5V6h3.3'];

/** Les tracés du shell : même épaisseur, mêmes jointures, un seul endroit. */
export const Glyph = ({paths, size = 16}: {paths: string[]; size?: number}) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    {paths.map(d => (
      <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"/>
    ))}
  </svg>
);

/**
 * L'icône d'une page. `renderPageIcon` écrit lui-même dans le nœud — il sait
 * rendre un émoji, une image ou un émoji personnalisé — donc on lui prête un
 * hôte plutôt que de redire ses trois cas ici.
 */
export const PageMark = ({icon, attribute}: {icon?: string; attribute: string}) => {
  const host = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node || !icon) return;
    renderPageIcon(node, icon);
    return () => node.replaceChildren();
  }, [icon]);

  return <span ref={host} {...{[attribute]: ''}} aria-hidden="true">
    {icon ? null : <Glyph paths={PAGE_GLYPH}/>}
  </span>;
};
