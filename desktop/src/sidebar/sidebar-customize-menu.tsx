import {shellText} from '../shell-i18n';
import { Check } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import {
  sidebarPromptLabels,
  type SidebarPreferences,
  type SidebarSection,
} from '../../../src/shell/sidebar-preferences';
import { DismissButton, DropdownMenuCheckboxItem } from '../components';
import { SidebarIcon } from './sidebar-icon';
import { SidebarMenu } from './sidebar-menu';
import { navigationLabels, useNavigationLayout, type NavigationId } from './navigation-layout';
import type { SidebarOptions } from './sidebar-frame';

const PreferenceItem = ({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) => (
  <DropdownMenuCheckboxItem
    nativeButton
    render={<button type="button" />}
    checked={checked}
    closeOnClick
    onCheckedChange={onChange}
  >
    <span data-blok-sidebar-menu-label="">{label}</span>
    {checked && (
      <Check
        size={16}
        aria-hidden="true"
      />
    )}
  </DropdownMenuCheckboxItem>
);

export const SidebarPreferenceItems = ({
  prefs,
  pages = [],
}: {
  prefs: SidebarPreferences;
  pages?: SidebarOptions['pages'];
}) => {
  const layout = useNavigationLayout();
  const visible = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot);
  const sections: [string, string][] = [['favorites', navigationLabels.favorites]];
  if (prefs.hasEvents) sections.unshift(['events', navigationLabels.events]);
  const knownSections = new Set(pages.map((page) => page.section));
  if (layout) {
    const opts = layout.options;
    const items: NavigationId[] = [];
    if (opts.canCreate?.(null) !== false) items.push('newPage');
    if (opts.onNewChat) items.push('newChat');
    if (opts.onLibrary) items.push('library');
    if (opts.onTeamspaces && opts.hasTeamspaces) items.push('teamsLink');
    if (!opts.onLibrary) items.push('recents');
    if (opts.teamspace) items.push('workspace');
    if (opts.teamspace || pages.some((p) => p.section === 'Partagé')) items.push('Partagé');
    if (opts.onCreatePrivate || pages.some((p) => p.section === 'Privé')) items.push('Privé');
    sections.push(...items.map((id): [string, string] => [id, navigationLabels[id]]));
  }
  const known = new Set(sections.map(([key]) => key));
  for (const section of knownSections) {
    if (section && !known.has(section)) sections.push([section, section]);
  }
  const entries = sections.filter(([id]) => !layout || layout.tab(id) === layout.mode);
  const isVisible = (id: string) => layout?.visible(id) ?? visible[id as SidebarSection];
  return (
    <>
      {entries.map(([id, label]) => (
        <PreferenceItem
          key={id}
          label={label}
          checked={isVisible(id)}
          onChange={(checked) =>
            layout ? layout.show(id, checked) : prefs.set(id as SidebarSection, checked)
          }
        />
      ))}
      {prefs.prompts.map((id) => (
        <PreferenceItem
          key={id}
          label={shellText(sidebarPromptLabels[id])}
          checked={visible[id]}
          onChange={(checked) => prefs.set(id, checked)}
        />
      ))}
    </>
  );
};

export const SidebarPreferencesMenu = ({
  prefs,
  pages,
}: {
  prefs: SidebarPreferences;
  pages?: SidebarOptions['pages'];
}) => {
  const layout = useNavigationLayout();
  const visible = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot);
  if (!visible.customize) return null;
  const label = shellText(sidebarPromptLabels.customize);
  return (
    <div className="sidebar-customize-row">
      <SidebarMenu
        placement="preferences"
        triggerRef={layout?.customizeButton}
        label={label}
        attributes={{ 'data-blok-sidebar-customize': '' }}
        trigger={
          <>
            <SidebarIcon name="customize" />
            <span>{label}</span>
          </>
        }
      >
        <SidebarPreferenceItems
          prefs={prefs}
          pages={pages}
        />
      </SidebarMenu>
      {prefs.prompts.includes('customize') && (
        <DismissButton
          label={shellText("Masquer « {v0} »", {v0: label})}
          onDismiss={() => prefs.set('customize', false)}
        />
      )}
    </div>
  );
};
