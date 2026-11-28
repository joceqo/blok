import { Menu } from '@base-ui/react/menu';
import type { ComponentProps } from 'react';

export interface MenuSurfaceProps
  extends ComponentProps<typeof Menu.Popup>,
    Pick<
      Menu.Positioner.Props,
      | 'anchor'
      | 'side'
      | 'align'
      | 'sideOffset'
      | 'alignOffset'
      | 'collisionPadding'
      | 'collisionAvoidance'
    > {
  positionerClassName?: string;
  container?: Menu.Portal.Props['container'];
}

export const MenuSurface = ({
  positionerClassName,
  collisionPadding,
  collisionAvoidance,
  anchor,
  container,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  alignOffset = 0,
  ...popup
}: MenuSurfaceProps) => (
  <Menu.Portal container={container}>
    {/* Le bouton sert d’ancre par défaut. Le conteneur du portail permet de conserver le thème local. */}
    <Menu.Positioner
      className={positionerClassName}
      collisionPadding={collisionPadding}
      collisionAvoidance={collisionAvoidance}
      anchor={anchor}
      side={side}
      align={align}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
    >
      <Menu.Popup {...popup} />
    </Menu.Positioner>
  </Menu.Portal>
);
