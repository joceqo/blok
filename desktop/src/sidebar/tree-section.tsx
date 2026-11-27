import {shellText} from '../shell-i18n';
import type { LibraryView } from '../library-route';
import type { ReactNode } from 'react';
import { Button, DropdownMenuItem, SectionHeader, SectionAction } from '../components';
import { SidebarIcon } from './sidebar-icon';
import { SidebarMenu } from './sidebar-menu';
import { NavigationItemMenu } from './navigation-item-menu';
import { useTree } from './tree-context';

interface SectionProps {
  name: string;
  label: string;
  libraryView?: LibraryView;
  action?: ReactNode;
  children: ReactNode;
}

export const Section = ({ name, label, libraryView, action, children }: SectionProps) => {
  const { options, collapsed, toggleSection } = useTree();
  const openLibrary = options.onOpenLibrarySection;
  const destination = shellText('Ouvrir « {section} » dans la bibliothèque', {section: label});
  const open = !collapsed.has(name);
  return (
    <div
      data-blok-sidebar-section={name}
      data-blok-sidebar-favorites={name === 'favorites' ? '' : undefined}
      data-blok-sidebar-recents={name === 'recents' ? '' : undefined}
    >
      <SectionHeader
        data-blok-sidebar-section-header=""
        label={label}
        expanded={open}
        onToggle={() => toggleSection(name)}
      >
        {libraryView && openLibrary && (
          <SectionAction
            label={destination}
            tooltip={shellText("Ouvrir dans la bibliothèque")}
            onClick={() => openLibrary(libraryView)}
          >
            <SidebarIcon name="move" />
          </SectionAction>
        )}
        {action}
        <NavigationItemMenu
          id={name}
          label={label}
          kind="section"
        />
      </SectionHeader>
      {open && children}
    </div>
  );
};

interface WorkspaceSectionProps {
  name: string;
  children: ReactNode;
}

export const WorkspaceSection = ({ name, children }: WorkspaceSectionProps) => {
  const { options, collapsed, toggleSection } = useTree();
  const open = !collapsed.has('teamspace');
  return (
    <Section
      name="workspace"
      label={options.onTeamspaces && !options.onHome ? shellText("Pages de l’espace") : shellText("Espaces d’équipe")}
      libraryView="teamspaces"
      action={
        options.canCreateTeamspace &&
        options.onCreateTeamspace && (
          <SectionAction
            label={shellText("Créer un espace d’équipe")}
            onClick={options.onCreateTeamspace}
          >
            <SidebarIcon name="plus" />
          </SectionAction>
        )
      }
    >
      <div data-blok-sidebar-teamspace="">
        <Button
          variant="plain"
          type="button"
          aria-expanded={open}
          onClick={() => toggleSection('teamspace')}
        >
          <span
            data-blok-sidebar-teamspace-mark=""
            aria-hidden="true"
          >
            <SidebarIcon name="teamspace" />
            <SidebarIcon
              name="chevron"
              data-blok-sidebar-teamspace-chevron=""
            />
          </span>
          <span>{name}</span>
        </Button>
        {options.canCreate?.(null) !== false && (
          <Button
            variant="plain"
            type="button"
            data-blok-sidebar-teamspace-add=""
            aria-label={shellText("Créer dans {v0}", {v0: name})}
            onClick={() => options.onCreate(null)}
          >
            <SidebarIcon name="plus" />
          </Button>
        )}
        {options.teamspaceActions ? (
          <SidebarMenu
            label={shellText("Paramètres de {v0}", {v0: name})}
            placement="actions"
            attributes={{ 'data-blok-sidebar-teamspace-more': '' }}
            trigger={<SidebarIcon name="more" />}
          >
            {options.teamspaceActions.map((action) => (
              <DropdownMenuItem
                key={action.name}
                nativeButton
                render={<button type="button" />}
                onClick={action.run}
              >
                {action.title}
              </DropdownMenuItem>
            ))}
          </SidebarMenu>
        ) : (
          options.onTeamspaceMenu && (
            <Button
              variant="plain"
              type="button"
              data-blok-sidebar-teamspace-more=""
              aria-haspopup="menu"
              aria-label={shellText("Paramètres de {v0}", {v0: name})}
              onClick={(e) => options.onTeamspaceMenu?.(e.currentTarget)}
            >
              <SidebarIcon name="more" />
            </Button>
          )
        )}
      </div>
      {open && <div data-blok-sidebar-teamspace-pages="">{children}</div>}
    </Section>
  );
};
