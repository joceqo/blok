import {shellText} from '../shell-i18n';
import { MonitorDown, UserRoundPlus } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import {
  sidebarPromptLabels,
  type SidebarPreferences,
} from '../../../src/shell/sidebar-preferences';
import { SuggestionCard } from '../components';
import type { SidebarOptions } from './sidebar-frame';

export const SidebarSuggestions = ({
  prefs,
  options,
}: {
  prefs: SidebarPreferences;
  options: SidebarOptions;
}) => {
  const visible = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot);
  const cards = [
    {
      id: 'invite',
      description: shellText("Collaborez avec votre équipe."),
      icon: UserRoundPlus,
      onSelect: options.onInviteMembers,
    },
    {
      id: 'download',
      description: shellText("Utilisez Blok sur votre ordinateur."),
      icon: MonitorDown,
      onSelect: options.onDownloadDesktop,
    },
  ] as const;
  const card = cards.find(({ id, onSelect }) => visible[id] && onSelect);
  if (!card?.onSelect) return null;
  const Icon = card.icon;
  return (
    <div className="sidebar-suggestions">
      <SuggestionCard
        title={shellText(sidebarPromptLabels[card.id])}
        description={card.description}
        icon={<Icon size={17} />}
        onSelect={card.onSelect}
        onDismiss={() => prefs.set(card.id, false)}
      />
    </div>
  );
};
