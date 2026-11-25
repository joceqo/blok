import {useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import type {Appearance} from './settings';
import {createChoice, type ChoiceOptions} from './ui/controls';
import {getTimeFormatter, readChatNewline, readContrast, readTimeFormat, setChatNewline, setContrast, setTimeFormat, subscribeDisplayPreferences, type Contrast, type TimeFormat} from './display-preferences';
import {SettingsSwitchRow} from './settings-switch-row';
import './settings-panels.css';

type Preferences = {
  kind: 'preferences';
  appearance: Appearance;
  onAppearanceChange(mode: Appearance): void;
  readDirectory?: () => Promise<string>;
};

type General = {
  kind: 'general';
  workspace: string;
  version: string;
  remoteServer?: string;
};

type Account =
  | {kind: 'local'; name: string; rename(value: string): void}
  | {kind: 'device'; name: string; workspace: string}
  | {kind: 'remote'; email?: string; name?: string; workspace: string; role: string; openAccounts(): void};

function Section({title, children}: {title: string; children: ReactNode}) {
  return <section className="settings-panel-section">
    <h2>{title}</h2>
    {children}
  </section>;
}

function Directory({read}: {read: () => Promise<string>}) {
  const [path, setPath] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    read().then(value => { if (active) setPath(value || ''); }, () => { if (active) setPath(''); });
    return () => { active = false; };
  }, [read]);

  async function copyPath() {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setNotice('Chemin copié');
    } catch {
      setNotice('Copie impossible. Vous pouvez sélectionner le chemin.');
    }
  }
  return <details className="settings-panel-directory">
    <summary>Avancé</summary>
    <div>Dossier des données</div>
    <code data-desktop-settings-path="">{path ?? 'Chargement…'}{path === '' && 'Indisponible'}</code>
    <button type="button" data-desktop-settings-copy="" disabled={!path} onClick={copyPath}>Copier le chemin des données</button>
    <span role="status">{notice}</span>
  </details>;
}

const themes = [{value: 'dark', label: 'Sombre'}, {value: 'light', label: 'Clair'}, {value: 'auto', label: 'Système'}] as const;
const contrasts = [{value: 'system', label: 'Utiliser le réglage système'}, {value: 'more', label: 'Activé'}, {value: 'standard', label: 'Désactivé'}] as const;
const timeFormats = [{value: 'system', label: 'Utiliser le réglage système'}, {value: '24h', label: '24 heures'}, {value: '12h', label: '12 heures'}] as const;

function SettingChoice<T extends string>({attribute, label, value, options, onChange}: ChoiceOptions<T> & {attribute: string}) {
  const host = useRef<HTMLDivElement>(null);
  const control = useRef<ReturnType<typeof createChoice<T>> | null>(null);
  const initialValue = useRef(value);
  useLayoutEffect(() => {
    const choice = createChoice({label, value: initialValue.current, options, onChange});
    choice.element.setAttribute(attribute, '');
    host.current?.append(choice.element);
    control.current = choice;
    return () => { choice.destroy(); choice.element.remove(); };
  }, [attribute, label, options, onChange]);
  useLayoutEffect(() => { control.current?.setValue(value); }, [value]);
  return <div ref={host}/>;
}

function PreferencesPanel({appearance, onAppearanceChange, readDirectory}: Preferences) {
  const contrast = useSyncExternalStore(subscribeDisplayPreferences, readContrast);
  const newline = useSyncExternalStore(subscribeDisplayPreferences, readChatNewline);
  const timeFormat = useSyncExternalStore(subscribeDisplayPreferences, readTimeFormat);

  return <>
    <h1 data-desktop-settings-title="">Préférences</h1>
    <p data-desktop-settings-intro="">Choisissez l’apparence et le comportement de Blok.</p>
    <Section title="Apparence">
      <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>Thème</strong><small>Choisissez un thème pour Blok sur cet appareil.</small></div>
        <SettingChoice<Appearance> attribute="data-desktop-settings-theme" label="Thème" value={appearance} options={themes} onChange={onAppearanceChange}/>
      </div>
      <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>Contraste élevé</strong><small>Renforcez le contraste du texte et des contours.</small></div>
        <SettingChoice<Contrast> attribute="data-desktop-settings-contrast" label="Contraste élevé" value={contrast} options={contrasts} onChange={setContrast}/>
      </div>
    </Section>
    <Section title="Options de saisie">
      <SettingsSwitchRow label="Utiliser Entrée pour insérer un saut de ligne"
        help="Dans les conversations avec l’assistant, utilisez Cmd ou Ctrl + Entrée pour envoyer le message."
        checked={newline} onChange={setChatNewline}/>
    </Section>
    <Section title="Langue et heure">
      <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>Format de l’heure</strong><small>Dans le calendrier, un événement à 16 h 30 s’affiche « {getTimeFormatter().format(new Date(2000, 0, 15, 16, 30))} ».</small></div>
        <SettingChoice<TimeFormat> attribute="data-desktop-settings-time-format" label="Format de l’heure" value={timeFormat} options={timeFormats} onChange={setTimeFormat}/>
      </div>
    </Section>
    {readDirectory && <Directory read={readDirectory}/>}
  </>;
}

function AccountPanel({account}: {account: Account}) {
  const initialName = account.kind === 'remote' ? account.email || account.name || 'Compte en ligne' : account.name;
  const [name, setName] = useState(initialName);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const field = input.current;
    if (account.kind !== 'local' || !field) return;
    // Commit once when the edit finishes, including native change events from the shell.
    const commit = () => {
      const next = field.value.trim() || 'Espace local';
      field.value = next;
      account.rename(next);
      setName(next);
    };
    field.addEventListener('change', commit);
    return () => field.removeEventListener('change', commit);
  }, [account]);

  return <>
    <h1 data-desktop-settings-title="">{account.kind === 'remote' ? 'Mon compte' : 'Profil local'}</h1>
    <p data-desktop-settings-intro="">{account.kind === 'remote' ? 'Votre identité et votre accès à cet espace.' : 'Votre profil et vos documents sont enregistrés sur cet appareil.'}</p>
    <Section title="Identité">
      <div className="settings-panel-identity">
        <span className="settings-panel-avatar" aria-hidden="true">{Array.from(name)[0]?.toLocaleUpperCase() || 'B'}</span>
        {account.kind === 'local' ?
          <label className="settings-panel-label"><small>Nom du profil local</small>
            <input ref={input} type="text" maxLength={48} defaultValue={initialName} data-desktop-settings-name="" data-blok-field="text"
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}/>
          </label> :
          <div className="settings-panel-label"><small>{account.kind === 'remote' && account.email ? 'Adresse e-mail' : 'Nom du profil'}</small><strong>{name}</strong></div>}
      </div>
    </Section>
    {account.kind !== 'local' && <Section title="Espace de travail">
      <dl className="settings-panel-values">
        <div><dt>Nom</dt><dd>{account.workspace}</dd></div>
        {account.kind === 'remote' && <div><dt>Rôle</dt><dd>{account.role}</dd></div>}
      </dl>
    </Section>}
    {account.kind === 'remote' && <Section title="Comptes et espaces">
      <div className="settings-panel-row"><div className="settings-panel-label"><strong>Changer de compte</strong><small>Accédez à vos autres espaces ou connectez un compte.</small></div>
        <button type="button" data-desktop-settings-copy="" onClick={account.openAccounts}>Comptes et espaces</button>
      </div>
    </Section>}
  </>;
}

function GeneralPanel({workspace, version, remoteServer}: General) {
  return <>
    <h1 data-desktop-settings-title="">Général</h1>
    <p data-desktop-settings-intro="">Informations sur votre espace de travail.</p>
    <Section title="Espace de travail">
      <dl className="settings-panel-values">
        <div><dt>Nom de l’espace</dt><dd>{workspace}</dd></div>
        <div><dt>Hébergement</dt><dd>{remoteServer ? 'Serveur distant' : 'Sur cet appareil'}</dd></div>
      </dl>
      {remoteServer && <details className="settings-panel-directory">
        <summary>Adresse du serveur</summary>
        <code>{remoteServer}</code>
      </details>}
    </Section>
    <Section title="À propos">
      <p data-desktop-settings-version="">{version}</p>
    </Section>
  </>;
}

export function mountSettingsPanel(host: HTMLElement, panel: Account | Preferences | General): {destroy(): void} {
  const root = createRoot(host);
  host.classList.add('settings-panel');
  let content: ReactNode;
  if (panel.kind === 'preferences') content = <PreferencesPanel {...panel}/>;
  else if (panel.kind === 'general') content = <GeneralPanel {...panel}/>;
  else content = <AccountPanel account={panel}/>;
  flushSync(() => root.render(content));
  return {destroy: () => root.unmount()};
}
