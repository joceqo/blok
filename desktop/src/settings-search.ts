import {shellText} from './shell-i18n';
import {sidebarPromptLabels, type SidebarPreferences} from '../../src/shell/sidebar-preferences';
import {nativeMacNotifications} from './cloud/system-notifications';
import type {WorkspaceRef} from './workspace-registry';

export type SettingsPanel =
  | 'account' | 'preferences' | 'notifications' | 'calendar' | 'general' | 'members' | 'sidebar' | 'import'
  | 'backups' | 'ai' | 'emojis' | 'connections' | 'mcp' | 'teams' | 'developer'
  | 'instance-general' | 'instance-access' | 'instance-accounts' | 'instance-workspaces' | 'instance-health';

export interface SettingsTab {
  panel: SettingsPanel;
  group: string;
  button: HTMLButtonElement;
  keywords: string;
}

export interface Setting {
  label: string;
  description: string;
  selector: string;
  keywords: string;
}

function setting(label: string, description: string, selector: string, keywords = ''): Setting {
  return {label, description, selector, keywords};
}

export function settingsCatalog(workspace: WorkspaceRef, sidebar: SidebarPreferences, native: boolean, markdown: boolean, canExport = false) {
  const disk = workspace.kind === 'local';
  const online = workspace.kind === 'remote' && !workspace.embedded;
  const catalog: Partial<Record<SettingsPanel, Setting[]>> = {
    account: [
      setting(disk ? shellText("Nom du profil local") : shellText("Identité du profil"), shellText("Consulter votre identité sur cet espace."), '.settings-panel-identity', 'nom compte'),
      ...(online ? [
        setting(shellText("Rôle"), shellText("Consulter vos droits dans cet espace de travail."), '[data-setting="role"]'),
        setting(shellText("Changer de compte"), shellText("Accéder à vos autres comptes et espaces."), '[data-setting="accounts"]'),
      ] : []),
    ],
    preferences: [
      setting(shellText("Thème"), shellText("Choisir le thème clair, sombre ou système."), '[data-desktop-settings-theme]', 'apparence'),
      setting(shellText("Contraste élevé"), shellText("Renforcer le contraste du texte et des contours."), '[data-desktop-settings-contrast]', 'apparence accessibilité'),
      setting(shellText("Utiliser Entrée pour insérer un saut de ligne"), shellText("Envoyer les messages avec Cmd ou Ctrl + Entrée."), '[data-setting="newline"]', 'options de saisie conversation assistant'),
      setting(shellText("Langue"), shellText("Choisissez la langue de Blok sur cet appareil."), '[data-desktop-settings-language]', 'language idioma sprache'),
      setting(shellText("Format de l’heure"), shellText("Afficher les heures du calendrier sur 12 ou 24 heures."), '[data-desktop-settings-time-format]', 'langue et heure système'),
      ...(native && disk ? [setting(shellText("Dossier des données"), shellText("Consulter et copier le chemin du dossier local."), '.settings-panel-directory', 'avancé stockage')] : []),
    ],
    backups: [setting(shellText("Destination"), shellText("Sauvegarder cet espace"), '[data-backup-destination]', 'git github gitlab s3 nas dossier restauration backup')],
    general: [
      ...(canExport ? [setting(shellText("Exporter"), shellText("Contenu de l’espace de travail"), '[data-setting="workspace-export"]', 'zip markdown csv html')] : []),
      setting(shellText("Nom de l’espace"), online ? shellText("Renommer cet espace de travail.") : shellText("Consulter le nom de cet espace de travail."), '[data-setting="workspace-name"]', 'renommer titre'),
      setting(shellText("Hébergement"), shellText("Voir où cet espace est stocké."), '[data-setting="hosting"]', 'stockage'),
      setting(shellText("Version de Blok"), shellText("Consulter les versions de Blok et de l’application."), '[data-desktop-settings-version]', 'à propos'),
      ...(online ? [
        setting(shellText("Adresse du serveur"), shellText("Consulter l’adresse de cet espace distant."), '.settings-panel-directory', 'url'),
        setting(shellText("Identifiant de l’espace de travail"), shellText("Copier l’identifiant que demandent l’API et le support."), '[data-setting="workspace-id"]', 'id uuid api support'),
      ] : []),
    ],
    sidebar: [
      setting(shellText("Favoris"), shellText("Afficher les pages favorites dans la barre latérale."), '[data-setting="favorites"]'),
      ...(sidebar.hasEvents ? [setting(shellText("Événements à venir"), shellText("Afficher les événements du calendrier dans la barre latérale."), '[data-setting="events"]')] : []),
      ...sidebar.prompts.map(id => setting(shellText(sidebarPromptLabels[id]), shellText("Afficher cette suggestion en bas de la barre latérale."), '[data-setting="' + id + '"]')),
    ],
    notifications: [
      setting(shellText("Commentaires et mentions"), shellText("Recevoir les alertes de commentaires sur cet appareil."), '[data-setting="comments"]'),
      setting(shellText("Envoyer une notification test"), shellText("Vérifier la réception des notifications système."), '[data-setting="test-notification"]'),
      setting(shellText("Compteur de notifications non lues"), shellText("Afficher le compteur de la boîte de réception."), '[data-setting="badge"]', 'inbox'),
      setting(shellText("Épingler le volet"), shellText("Garder la boîte de réception à côté du document."), '[data-setting="pinned"]', 'inbox'),
      ...(nativeMacNotifications() ? [setting(shellText("Pastille sur l’icône de l’app"), shellText("Régler le badge de notification macOS."), '[data-setting="mac-badge"]')] : []),
      setting(shellText("Activité dans mon espace de travail"), shellText("Recevoir par e-mail les commentaires, mentions et invitations."), '[data-setting="email-activity"]', 'e-mail email'),
      setting(shellText("Toujours envoyer des notifications par e-mail"), shellText("Recevoir les e-mails même pendant que vous utilisez Blok."), '[data-setting="email-always"]', 'e-mail email'),
      setting(shellText("Modifications de pages"), shellText("Recevoir les récapitulatifs des pages suivies par e-mail."), '[data-setting="email-page-updates"]', 'e-mail email'),
      setting(shellText("Récapitulatif des activités de l’espace de travail"), shellText("Recevoir un résumé par e-mail de l’activité de l’espace."), '[data-setting="email-digest"]', 'e-mail email'),
    ],
    import: [
      ...(markdown ? [setting(shellText("Notion et dossiers ZIP"), shellText("Importer une archive avec ses sous-pages."), '[data-setting="archive-import"]', 'migration html zip')] : []),
      setting('iCalendar', shellText("Importer les événements d’un fichier .ics."), '[data-setting="ical"]', 'agenda calendrier'),
      ...(markdown ? [setting(shellText('Markdown et CSV'), shellText("Créer une page à partir d’un fichier Markdown ou CSV."), '[data-setting="markdown"]')] : []),
    ],
    calendar: [
      setting(shellText("Agendas"), shellText("Afficher le calendrier de l’espace de travail."), '[data-calendar-group="workspace"]'),
      ...(!disk ? [
        setting(shellText("Google Agenda"), shellText("Consulter la connexion et les agendas du compte Google."), '[data-calendar-group="google"] h2'),
        setting(shellText("Abonnements"), shellText("Ajouter un agenda par son adresse WebCal ou HTTPS."), '[data-calendar-group="feeds"] h2'),
        setting(shellText("Disponibilités de l’équipe"), shellText("Consulter les agendas partagés par les membres."), '[data-calendar-group="team"] h2'),
      ] : []),
      setting(shellText("Ouvrir le calendrier"), shellText("Accéder à l’agenda de cet espace."), '[data-desktop-settings-copy]'),
    ],
    connections: [setting(native && !online ? shellText("Serveur distant") : shellText("Comptes et espaces"), shellText("Se connecter à un autre espace Blok."), '[data-desktop-connections-accounts]')],
    emojis: [
      setting(shellText("Émojis personnalisés"), shellText("Rechercher les émojis de cet espace."), '[data-custom-emoji-tools] input'),
      ...(disk || workspace.role !== 'viewer' ? [setting(shellText("Ajouter un émoji"), shellText("Choisir une image pour un nouvel émoji."), '[data-custom-emoji-tools] [data-cloud-settings-primary]')] : []),
    ],
    ai: [
      ...(!disk || native ? [setting(shellText("Ma clé OpenAI"), shellText("Configurer la clé API personnelle de l’assistant."), '[data-ai-scope="personal"]')] : []),
      ...(native ? [setting(shellText("Agents sur ce Mac"), shellText("Vérifier la connexion de Codex et Claude Code."), '[data-desktop-settings-provider-status]')] : []),
    ],
    teams: [setting(shellText("Rechercher un espace d’équipe"), shellText("Retrouver les équipes auxquelles vous avez accès."), '.teamspace-toolbar .teamspace-icon-button')],
    members: [setting(shellText("Rechercher un membre"), shellText("Retrouver une personne dans cet espace."), '[data-cloud-members-search]')],
    mcp: [
      setting(shellText("Adresse du serveur MCP"), shellText("Copier l’URL à utiliser dans votre client."), '[data-desktop-mcp-endpoint]'),
      setting(shellText("Créer un jeton"), shellText("Nommer le client qui utilisera ce jeton MCP."), '[data-desktop-mcp-create]', 'codex'),
      setting(shellText("Jetons d’accès"), shellText("Consulter les jetons MCP existants."), '[data-desktop-mcp-list-heading]'),
    ],
    developer: [setting(shellText("Sélectionner un élément"), shellText("Inspecter un composant avec React Grab."), '[data-desktop-settings-grab]')],
    'instance-general': [setting(shellText("Nom de l’instance"), shellText("Nom affiché à la connexion et dans les e-mails."), '[data-desktop-instance-name]')],
    'instance-access': [
      setting(shellText("Inscription"), shellText("Choisir qui peut créer un compte sur cette instance."), '[data-desktop-instance-signup]'),
      setting(shellText("Création d’espaces"), shellText("Choisir qui peut créer un espace de travail."), '[data-desktop-instance-workspace-creation]'),
    ],
    'instance-health': [setting(shellText("Envoyer un e-mail de test"), shellText("Vérifier la livraison des e-mails de l’instance."), '[data-desktop-instance-email-form]', 'smtp')],
  };
  return catalog;
}

export interface ResultGroup {
  panel: SettingsPanel;
  group: string;
  title: string;
  results: Setting[];
}

const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/['’]/g, ' ');

export function findSettings(query: string, tabs: SettingsTab[], catalog: ReturnType<typeof settingsCatalog>): ResultGroup[] {
  const terms = normalize(query).trim().split(/\s+/);
  const matches = (value: string) => {
    const text = normalize(value);
    return terms.every(term => text.includes(term));
  };
  return tabs.flatMap(({panel, group, button, keywords}) => {
    const title = button.textContent.trim();
    const path = group + ' ' + title;
    const results = (catalog[panel] ?? []).filter(item => matches([path, item.label, item.description, item.keywords].join(' ')));
    if (!results.length && matches(path + ' ' + keywords)) {
      results.push(setting(title, shellText("Ouvrir cette rubrique."), '[data-desktop-settings-title], h1'));
    }
    return results.length ? [{panel, group, title, results}] : [];
  });
}

// Some administration panels render their controls only after the server responds.
export function revealSetting(main: HTMLElement, selector: string, signal: AbortSignal) {
  const focusTarget = () => {
    const target = main.querySelector<HTMLElement>(selector);
    if (!target || target.closest('[hidden]')) return false;
    const row = target.closest<HTMLElement>('.settings-panel-row, .settings-panel-identity, [data-desktop-settings-row]') ?? target;
    const details = row.closest('details');
    if (details) details.open = true;
    const controls = 'button:enabled, input:enabled:not([hidden]), select:enabled, textarea:enabled, summary';
    const control = target.matches(controls) ? target : row.querySelector<HTMLElement>(controls);
    if (!control) row.tabIndex = -1;
    (control ?? row).focus({preventScroll: true});
    row.scrollIntoView?.({block: 'center', behavior: 'instant'});
    row.dataset.settingsHighlight = '';
    return true;
  };
  if (focusTarget()) return;
  main.setAttribute('tabindex', '-1');
  main.focus({preventScroll: true});
  const observer = new MutationObserver(() => { if (focusTarget()) observer.disconnect(); });
  observer.observe(main, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden']});
  signal.addEventListener('abort', () => observer.disconnect(), {once: true});
}
