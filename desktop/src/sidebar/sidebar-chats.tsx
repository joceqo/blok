import { shellText } from '../shell-i18n';
import { SidebarIcon } from './sidebar-icon';

/** A conversation as the assistant keeps it */
export interface SidebarChat {
  id: string;
  title: string;
  excerpt: string;
}

export interface SidebarChatsProps {
  /** Read when the sidebar draws: the assistant owns them */
  chats(): readonly SidebarChat[];
  onOpen(id: string): void;
  onNew(): void;
}

/**
 * The sidebar's chat tab: the conversations held with the assistant, newest
 * first, and a way to start another.
 *
 * It replaces the page tree rather than sitting beside it — the tab is a view
 * of the workspace, not a section of one.
 */
export function SidebarChats({ chats, onOpen, onNew }: SidebarChatsProps) {
  const held = [...chats()].reverse();
  return (
    <div data-blok-sidebar-chats="">
      <button type="button" data-blok-sidebar-new-chat="" onClick={onNew}>
        <SidebarIcon name="newChat" />
        <span>{shellText("Nouvelle discussion")}</span>
      </button>
      {held.length === 0 ? (
        <p data-blok-sidebar-chats-empty="">
          {shellText("Vos discussions avec l’assistant s’afficheront ici.")}
        </p>
      ) : (
        <ul data-blok-sidebar-chats-list="">
          {held.map((chat) => (
            <li key={chat.id}>
              <button
                type="button"
                data-blok-sidebar-chat={chat.id}
                onClick={() => onOpen(chat.id)}
                title={chat.title || chat.excerpt}
              >
                {chat.title || chat.excerpt || shellText("Discussion sans titre")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
