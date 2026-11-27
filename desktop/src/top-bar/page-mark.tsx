import {useLayoutEffect, useRef} from 'react';
import {renderPageIcon} from '../../../src/shell/page-icon';
import {IconPage} from '../../../src/components/icons';

/**
 * Une icône de la famille Blok Line, telle qu'elle est dessinée une seule
 * fois dans `src/components/icons`. La barre du haut en redessinait ses
 * propres copies en 16×16 : mêmes sujets, tracés différents.
 */
export const Glyph = ({svg}: {svg: string}) => (
  <span className="top-bar-glyph" aria-hidden="true" dangerouslySetInnerHTML={{__html: svg}}/>
);

/**
 * « Sur cet appareil » n'a pas d'équivalent dans la famille : c'est le seul
 * tracé que la barre dessine encore elle-même, aux mêmes conventions.
 */
export const DeviceGlyph = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    {['M3.5 4.5h13v9h-13z', 'M7.5 16.5h5'].map(d => (
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
    {icon ? null : <Glyph svg={IconPage}/>}
  </span>;
};
