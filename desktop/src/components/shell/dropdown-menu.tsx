import './shell-ui.css';
import { Menu } from '@base-ui/react/menu';
import { MenuSurface, type MenuSurfaceProps } from '../primitives/menu-surface';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuCheckboxItem = Menu.CheckboxItem;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export const DropdownMenuRadioItem = Menu.RadioItem;
export const DropdownMenuItem = Menu.Item;

export type DropdownMenuContentProps = Omit<MenuSurfaceProps, 'positionerClassName'>;

export const DropdownMenuContent = (props: DropdownMenuContentProps) => (
  <MenuSurface
    data-blok-dropdown-menu=""
    positionerClassName="blok-shell-menu-positioner"
    {...props}
  />
);

export const DropdownMenuSubmenu = Menu.SubmenuRoot;
export const DropdownMenuSubmenuTrigger = Menu.SubmenuTrigger;
