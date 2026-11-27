import {shellText} from './shell-i18n';
import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {sidebarPromptLabels, type SidebarPreferences} from '../../src/shell/sidebar-preferences';
import {readInboxPreference, setInboxPreference, subscribeInboxPreferences} from './cloud/inbox-preferences';
import {loadEmailNotifications, readEmailNotification, setEmailNotification, subscribeEmailNotifications, type EmailNotificationScope} from './cloud/email-notification-preferences';
import {nativeMacNotifications, openSystemNotificationSettings, sendSystemNotice, systemPermission, type SystemPermission} from './cloud/system-notifications';
import {SettingsSwitchRow} from './settings-switch-row';
import './settings-panels.css';

function SidebarPanel({sidebar}: {sidebar: SidebarPreferences}) {
  const visibility = useSyncExternalStore(sidebar.subscribe, sidebar.getSnapshot);
  return <>
    <h1 data-desktop-settings-title="">{shellText("Barre latérale")}</h1>
    <p data-desktop-settings-intro="">{shellText("Choisissez les sections visibles dans la barre latérale de cet espace.")}</p>
    <section className="settings-panel-section">
      <h2>{shellText("Sections")}</h2>
      {sidebar.hasEvents && <SettingsSwitchRow settingId="events" label={shellText("Événements à venir")}
        help={shellText("Afficher la section du calendrier dans la barre latérale.")} checked={visibility.events}
        onChange={value => sidebar.set('events', value)}/>}
      <SettingsSwitchRow settingId="favorites" label={shellText("Favoris")} help={shellText("Retrouver dans la barre latérale les pages ajoutées à vos favoris.")}
        checked={visibility.favorites} onChange={value => sidebar.set('favorites', value)}/>
    </section>
    {sidebar.prompts.length > 0 && <section className="settings-panel-section">
      <h2>{shellText("En bas de la barre latérale")}</h2>
      {sidebar.prompts.map(id => <SettingsSwitchRow key={id} settingId={id} label={shellText(sidebarPromptLabels[id])}
        help={{customize:'Afficher le raccourci de personnalisation.', invite:'Proposer d’inviter des personnes dans cet espace.', download:'Proposer l’application de bureau dans le navigateur.'}[id]} checked={visibility[id]} onChange={value => sidebar.set(id, value)}/>)}
    </section>}
  </>;
}

function EmailNotifications() {
  const activity = useSyncExternalStore(subscribeEmailNotifications, () => readEmailNotification('activity'));
  const always = useSyncExternalStore(subscribeEmailNotifications, () => readEmailNotification('always'));
  const pageUpdates = useSyncExternalStore(subscribeEmailNotifications, () => readEmailNotification('pageUpdates'));
  const digest = useSyncExternalStore(subscribeEmailNotifications, () => readEmailNotification('digest'));
  return <section className="settings-panel-section">
    <h2>{shellText("Notifications par e-mail")}</h2>
    <SettingsSwitchRow settingId="email-activity" label={shellText("Activité dans mon espace de travail")}
      help={shellText("Recevez des e-mails à chaque commentaire, mention, invitation à rejoindre une page, rappel, demande d’accès ou modification de propriété de base de données")}
      checked={activity} onChange={value => setEmailNotification('activity', value)}/>
    <SettingsSwitchRow settingId="email-always" label={shellText("Toujours envoyer des notifications par e-mail")}
      help={shellText("Recevez des e-mails concernant l’activité de l’espace de travail, même lorsque vous utilisez Blok")}
      checked={always} onChange={value => setEmailNotification('always', value)}/>
    <SettingsSwitchRow settingId="email-page-updates" label={shellText("Modifications de pages")}
      help={shellText("Recevez des e-mails récapitulatifs sur les pages pour lesquelles vous avez activé les notifications et celles que vous avez créées")}
      checked={pageUpdates} onChange={value => setEmailNotification('pageUpdates', value)}/>
    <SettingsSwitchRow settingId="email-digest" label={shellText("Récapitulatif des activités de l’espace de travail")}
      help={shellText("Recevez des résumés par e-mail de ce qui se passe dans votre espace de travail")}
      checked={digest} onChange={value => setEmailNotification('digest', value)}/>
  </section>;
}

function NotificationsPanel() {
  const badge = useSyncExternalStore(subscribeInboxPreferences, () => readInboxPreference('badge'));
  const pinned = useSyncExternalStore(subscribeInboxPreferences, () => readInboxPreference('pinned'));
  const comments = useSyncExternalStore(subscribeInboxPreferences, () => readInboxPreference('comments'));
  const [permission,setPermission] = useState<SystemPermission | null>(null);
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const refresh = () => { void systemPermission().then(value => {
      if (active && !pending.current) setPermission(value);
    }).catch(() => { if (active) setPermission('unavailable'); }); };
    refresh();
    window.addEventListener('focus',refresh);
    return () => { mounted.current = active = false; window.removeEventListener('focus',refresh); };
  }, []);
  async function enableOrTest(test: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus('');
    try {
      const value = await systemPermission(true);
      if (!mounted.current) return;
      setPermission(value);
      if (value !== 'granted') {
        setStatus(value === 'denied' ? shellText("Les notifications sont bloquées. Autorisez Blok dans les réglages de notification de cet appareil.") :
          shellText("Aucune autorisation accordée."));
        return;
      }
      if (test) {
        await sendSystemNotice('blok-test', 'Les notifications Blok fonctionnent sur cet appareil.');
        if (mounted.current) setStatus(shellText("Notification test envoyée."));
      } else setInboxPreference('comments',true);
    } catch {
      if (mounted.current) setStatus(shellText("Impossible d’envoyer des notifications sur cet appareil."));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const blocked = busy || permission === 'unavailable' || permission === null;
  return <>
    <h1 data-desktop-settings-title="">{shellText("Notifications")}</h1>
    <p data-desktop-settings-intro="">{shellText("Décidez quand et comment vous souhaitez recevoir vos notifications.")}</p>
    <section className="settings-panel-section">
      <h2>{shellText("Notifications système")}</h2>
      <SettingsSwitchRow settingId="comments" label={shellText("Commentaires et mentions")}
        help={shellText("Recevez une alerte lorsqu’une personne répond à votre commentaire ou vous mentionne sur une fiche de base de données, pendant que Blok est ouvert.")}
        checked={comments && permission === 'granted'} disabled={blocked}
        onChange={value => value ? void enableOrTest(false) : setInboxPreference('comments',false)}/>
      {nativeMacNotifications() && <div data-setting="mac-badge" className="settings-panel-row">
        <div className="settings-panel-label"><strong>{shellText("Pastille sur l’icône de l’app")}</strong><small>{shellText("Choisissez si macOS affiche le nombre de notifications non lues sur l’icône de Blok.")}</small></div>
        <button type="button" data-desktop-settings-copy="" onClick={() => void openSystemNotificationSettings().catch(() => setStatus(shellText("Ouvrez Réglages Système, puis Notifications.")))}>{shellText("↗ Réglages système")}</button>
      </div>}
      <div data-setting="test-notification" className="settings-panel-row">
        <div className="settings-panel-label"><strong>{shellText("Envoyer une notification test")}</strong><small>{permission === 'unavailable'
          ? shellText("Les notifications système sont indisponibles dans cet environnement.")
          : shellText("Envoyez-vous une notification pour vérifier qu’elle s’affiche sur cet appareil.")}</small></div>
        <button type="button" data-desktop-settings-copy="" disabled={blocked} onClick={() => void enableOrTest(true)}>{shellText("Envoyer une notification test")}</button>
      </div>
      {status && <p className="settings-notification-status" role="status">{status}</p>}
    </section>
    <section className="settings-panel-section">
      <h2>{shellText("Notifications dans l’application")}</h2>
      <SettingsSwitchRow settingId="badge" label={shellText("Compteur de notifications non lues")}
        help={shellText("Afficher le nombre de notifications non lues sur l’icône de la boîte de réception.")}
        checked={badge} onChange={value => setInboxPreference('badge', value)}/>
      <SettingsSwitchRow settingId="pinned" label={shellText("Épingler le volet")}
        help={shellText("Garder la boîte de réception à côté du document quand la fenêtre est assez large.")}
        checked={pinned} onChange={value => setInboxPreference('pinned', value)}/>
    </section>
    <EmailNotifications/>
  </>;
}

export function mountShellNavigationSettings(host: HTMLElement, panel: {kind: 'notifications'; scope?: EmailNotificationScope} | {kind: 'sidebar'; sidebar: SidebarPreferences}): {destroy(): void} {
  const root = createRoot(host);
  host.classList.add('settings-panel');
  flushSync(() => root.render(panel.kind === 'sidebar' ? <SidebarPanel sidebar={panel.sidebar}/> : <NotificationsPanel/>));
  // Les réglages appartiennent à l'espace : les lire est ce qui remplit le panneau.
  const loading = panel.kind === 'notifications' && panel.scope ? new AbortController() : null;
  if (panel.kind === 'notifications' && panel.scope && loading) void loadEmailNotifications(panel.scope, loading.signal);
  return {destroy: () => { loading?.abort(); root.unmount(); }};
}
