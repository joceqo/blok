import type {SupportedLocale} from '../../types/configs/i18n-config';
import {languageOptions, shellLocale, initializeShellLanguage, shellText} from './shell-i18n';
import {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import type {Appearance} from './settings';
import { Avatar, Choice, Feedback, SwitchRow, TextField } from './components';
import {getTimeFormatter, readAutoTimeZone, readChatNewline, readChosenTimeZone, readContrast, readTimeFormat, readTimeZone, setAutoTimeZone, setChatNewline, setContrast, setTimeFormat, setTimeZone, subscribeDisplayPreferences, type Contrast, type TimeFormat} from './display-preferences';
import {getTimeZoneOptions} from './calendarcn/lib/time-zones';
import './settings-panels.css';

type Preferences = {
  kind: 'preferences';
  appearance: Appearance;
  onAppearanceChange(mode: Appearance): void;
  onLanguageChange?: (locale: SupportedLocale) => Promise<void>;
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
      setNotice(shellText("Chemin copié"));
    } catch {
      setNotice(shellText("Copie impossible. Vous pouvez sélectionner le chemin."));
    }
  }
  return <details className="settings-panel-directory">
    <summary>{shellText("Avancé")}</summary>
    <div>{shellText("Dossier des données")}</div>
    <code data-desktop-settings-path="">{path ?? shellText("Chargement…")}{path === '' && 'Indisponible'}</code>
    <button type="button" data-desktop-settings-copy="" disabled={!path} onClick={copyPath}>{shellText("Copier le chemin des données")}</button>
    <Feedback>{notice}</Feedback>
  </details>;
}

const themes = [{value: 'dark', label: shellText("Sombre")}, {value: 'light', label: shellText("Clair")}, {value: 'auto', label: shellText("Système")}] as const;
const contrasts = [{value: 'system', label: shellText("Utiliser le réglage système")}, {value: 'more', label: shellText("Activé")}, {value: 'standard', label: shellText("Désactivé")}] as const;
const timeFormats = [{value: 'system', label: shellText("Utiliser le réglage système")}, {value: '24h', label: shellText("24 heures")}, {value: '12h', label: shellText("12 heures")}] as const;

const LanguagePreference = ({onChange}: {onChange?: Preferences['onLanguageChange']}) => {
  const [locale, setLocale] = useState(shellLocale);
  const [error, setError] = useState('');
  const options = useMemo(() => languageOptions(locale), [locale]);

  async function choose(next: SupportedLocale) {
    if (next === locale) return;
    try {
      if (onChange) await onChange(next);
      else await initializeShellLanguage(next);
      setLocale(next);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return <div className="settings-panel-row">
    <div className="settings-panel-label">
      <strong>{shellText('Langue')}</strong>
      <small>{shellText('Choisissez la langue de Blok sur cet appareil.')}</small>
    </div>
    <Choice attribute="data-desktop-settings-language" label={shellText('Langue')}
      value={locale} options={options} searchable onChange={next => { void choose(next); }}/>
    {error && <Feedback>{error}</Feedback>}
  </div>;
};

const TimeZonePreference = () => {
  const automatic = useSyncExternalStore(subscribeDisplayPreferences, readAutoTimeZone);
  const chosen = useSyncExternalStore(subscribeDisplayPreferences, readChosenTimeZone);
  const active = useSyncExternalStore(subscribeDisplayPreferences, readTimeZone);
  // Offsets move with the date, so they are read once per mount rather than per render.
  const options = useMemo(() => {
    const now = new Date();
    return getTimeZoneOptions(now).map(zone => ({value: zone.id, label: shellText("({v0}) {v1}", {v0: zone.offsetLabel, v1: zone.city}), description: zone.name}));
  }, []);

  return <>
    <SwitchRow settingId="auto-time-zone"
      label={shellText('Définir automatiquement votre fuseau horaire à partir de votre emplacement')}
      help={shellText('Les heures affichées dans Blok suivent alors le fuseau horaire de cet appareil.')}
      checked={automatic} onChange={setAutoTimeZone}/>
    <div className="settings-panel-row" data-setting="time-zone">
      <div className="settings-panel-label">
        <strong>{shellText('Fuseau horaire')}</strong>
        <small>{shellText('Choisissez votre fuseau horaire.')}</small>
      </div>
      <Choice attribute="data-desktop-settings-time-zone" label={shellText('Fuseau horaire')}
        value={automatic ? active : chosen} options={options} searchable disabled={automatic} onChange={setTimeZone}/>
    </div>
  </>;
};

function PreferencesPanel({appearance, onAppearanceChange, readDirectory, onLanguageChange}: Preferences) {
  const contrast = useSyncExternalStore(subscribeDisplayPreferences, readContrast);
  const newline = useSyncExternalStore(subscribeDisplayPreferences, readChatNewline);
  const timeFormat = useSyncExternalStore(subscribeDisplayPreferences, readTimeFormat);

  return <>
    <h1 data-desktop-settings-title="">{shellText("Préférences")}</h1>
    <p data-desktop-settings-intro="">{shellText("Choisissez l’apparence et le comportement de Blok.")}</p>
    <Section title={shellText("Apparence")}>
      <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>{shellText("Thème")}</strong><small>{shellText("Choisissez un thème pour Blok sur cet appareil.")}</small></div>
        <Choice<Appearance> attribute="data-desktop-settings-theme" label={shellText("Thème")} value={appearance} options={themes} onChange={onAppearanceChange}/>
      </div>
      <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>{shellText("Contraste élevé")}</strong><small>{shellText("Renforcez le contraste du texte et des contours.")}</small></div>
        <Choice<Contrast> attribute="data-desktop-settings-contrast" label={shellText("Contraste élevé")} value={contrast} options={contrasts} onChange={setContrast}/>
      </div>
    </Section>
    <Section title={shellText("Options de saisie")}>
      <SwitchRow settingId="newline" label={shellText("Utiliser Entrée pour insérer un saut de ligne")}
        help={shellText("Dans les conversations avec l’assistant, utilisez Cmd ou Ctrl + Entrée pour envoyer le message.")}
        checked={newline} onChange={setChatNewline}/>
    </Section>
    <Section title={shellText("Langue et heure")}>
      <LanguagePreference onChange={onLanguageChange}/>
      <div className="settings-panel-row">
        <div className="settings-panel-label"><strong>{shellText("Format de l’heure")}</strong><small>{shellText('Dans le calendrier, un événement à 16 h 30 s’affiche « {time} ».', {time: getTimeFormatter().format(new Date(2000, 0, 15, 16, 30))})}</small></div>
        <Choice<TimeFormat> attribute="data-desktop-settings-time-format" label={shellText("Format de l’heure")} value={timeFormat} options={timeFormats} onChange={setTimeFormat}/>
      </div>
      <TimeZonePreference/>
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
    <h1 data-desktop-settings-title="">{account.kind === 'remote' ? shellText("Mon compte") : shellText("Profil local")}</h1>
    <p data-desktop-settings-intro="">{account.kind === 'remote' ? shellText("Votre identité et votre accès à cet espace.") : shellText("Votre profil et vos documents sont enregistrés sur cet appareil.")}</p>
    <Section title={shellText("Identité")}>
      <div className="settings-panel-identity">
        <Avatar className="settings-panel-avatar" name={name}/>
        {account.kind === 'local' ?
          <label className="settings-panel-label"><small>{shellText("Nom du profil local")}</small>
            <TextField ref={input} maxLength={48} defaultValue={initialName} data-desktop-settings-name=""
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}/>
          </label> :
          <div className="settings-panel-label"><small>{account.kind === 'remote' && account.email ? shellText("Adresse e-mail") : shellText("Nom du profil")}</small><strong>{name}</strong></div>}
      </div>
    </Section>
    {account.kind !== 'local' && <Section title={shellText("Espace de travail")}>
      <dl className="settings-panel-values">
        <div><dt>{shellText("Nom")}</dt><dd>{account.workspace}</dd></div>
        {account.kind === 'remote' && <div data-setting="role"><dt>{shellText("Rôle")}</dt><dd>{account.role}</dd></div>}
      </dl>
    </Section>}
    {account.kind === 'remote' && <Section title={shellText("Comptes et espaces")}>
      <div className="settings-panel-row" data-setting="accounts"><div className="settings-panel-label"><strong>{shellText("Changer de compte")}</strong><small>{shellText("Accédez à vos autres espaces ou connectez un compte.")}</small></div>
        <button type="button" data-desktop-settings-copy="" onClick={account.openAccounts}>{shellText("Comptes et espaces")}</button>
      </div>
    </Section>}
  </>;
}

function GeneralPanel({workspace, version, remoteServer}: General) {
  return <>
    <h1 data-desktop-settings-title="">{shellText("Général")}</h1>
    <p data-desktop-settings-intro="">{shellText("Informations sur votre espace de travail.")}</p>
    <Section title={shellText("Espace de travail")}>
      <dl className="settings-panel-values">
        <div data-setting="workspace-name"><dt>{shellText("Nom de l’espace")}</dt><dd>{workspace}</dd></div>
        <div data-setting="hosting"><dt>{shellText("Hébergement")}</dt><dd>{remoteServer ? shellText("Serveur distant") : shellText("Sur cet appareil")}</dd></div>
      </dl>
      {remoteServer && <details className="settings-panel-directory">
        <summary>{shellText("Adresse du serveur")}</summary>
        <code>{remoteServer}</code>
      </details>}
    </Section>
    <Section title={shellText("À propos")}>
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
