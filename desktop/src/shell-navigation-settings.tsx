import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import type {SidebarPreferences} from '../../src/shell/sidebar-preferences';
import {readInboxPreference, setInboxPreference, subscribeInboxPreferences} from './cloud/inbox-preferences';
import {nativeMacNotifications, openSystemNotificationSettings, sendSystemNotice, systemPermission, type SystemPermission} from './cloud/system-notifications';
import {SettingsSwitchRow} from './settings-switch-row';
import './settings-panels.css';

function SidebarPanel({sidebar}: {sidebar: SidebarPreferences}) {
  const visibility = useSyncExternalStore(sidebar.subscribe, sidebar.getSnapshot);
  return <>
    <h1 data-desktop-settings-title="">Barre latérale</h1>
    <p data-desktop-settings-intro="">Choisissez les sections visibles dans la barre latérale de cet espace.</p>
    <section className="settings-panel-section">
      <h2>Sections</h2>
      {sidebar.hasEvents && <SettingsSwitchRow label="Événements à venir"
        help="Afficher la section du calendrier dans la barre latérale." checked={visibility.events}
        onChange={value => sidebar.set('events', value)}/>}
      <SettingsSwitchRow label="Favoris" help="Retrouver dans la barre latérale les pages ajoutées à vos favoris."
        checked={visibility.favorites} onChange={value => sidebar.set('favorites', value)}/>
    </section>
  </>;
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
        setStatus(value === 'denied' ? 'Les notifications sont bloquées. Autorisez Blok dans les réglages de notification de cet appareil.' :
          'Aucune autorisation accordée.');
        return;
      }
      if (test) {
        await sendSystemNotice('blok-test', 'Les notifications Blok fonctionnent sur cet appareil.');
        if (mounted.current) setStatus('Notification test envoyée.');
      } else setInboxPreference('comments',true);
    } catch {
      if (mounted.current) setStatus('Impossible d’envoyer des notifications sur cet appareil.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const blocked = busy || permission === 'unavailable' || permission === null;
  return <>
    <h1 data-desktop-settings-title="">Notifications</h1>
    <p data-desktop-settings-intro="">Décidez quand et comment vous souhaitez recevoir vos notifications.</p>
    <section className="settings-panel-section">
      <h2>Notifications système</h2>
      <SettingsSwitchRow label="Commentaires et mentions"
        help="Recevez une alerte lorsqu’une personne répond à votre commentaire ou vous mentionne sur une fiche de base de données, pendant que Blok est ouvert."
        checked={comments && permission === 'granted'} disabled={blocked}
        onChange={value => value ? void enableOrTest(false) : setInboxPreference('comments',false)}/>
      {nativeMacNotifications() && <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>Pastille sur l’icône de l’app</strong><small>Choisissez si macOS affiche le nombre de notifications non lues sur l’icône de Blok.</small></div>
        <button type="button" data-desktop-settings-copy="" onClick={() => void openSystemNotificationSettings().catch(() => setStatus('Ouvrez Réglages Système, puis Notifications.'))}>↗ Réglages système</button>
      </div>}
      <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>Envoyer une notification test</strong><small>{permission === 'unavailable'
          ? 'Les notifications système sont indisponibles dans cet environnement.'
          : 'Envoyez-vous une notification pour vérifier qu’elle s’affiche sur cet appareil.'}</small></div>
        <button type="button" data-desktop-settings-copy="" disabled={blocked} onClick={() => void enableOrTest(true)}>Envoyer une notification test</button>
      </div>
      {status && <p className="settings-notification-status" role="status">{status}</p>}
    </section>
    <section className="settings-panel-section">
      <h2>Notifications dans l’application</h2>
      <SettingsSwitchRow label="Compteur de notifications non lues"
        help="Afficher le nombre de notifications non lues sur l’icône de la boîte de réception."
        checked={badge} onChange={value => setInboxPreference('badge', value)}/>
      <SettingsSwitchRow label="Épingler le volet"
        help="Garder la boîte de réception à côté du document quand la fenêtre est assez large."
        checked={pinned} onChange={value => setInboxPreference('pinned', value)}/>
    </section>
  </>;
}

export function mountShellNavigationSettings(host: HTMLElement, panel: {kind: 'notifications'} | {kind: 'sidebar'; sidebar: SidebarPreferences}): {destroy(): void} {
  const root = createRoot(host);
  host.classList.add('settings-panel');
  flushSync(() => root.render(panel.kind === 'sidebar' ? <SidebarPanel sidebar={panel.sidebar}/> : <NotificationsPanel/>));
  return {destroy: () => root.unmount()};
}
