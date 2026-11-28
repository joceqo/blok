import type {SupportedLocale} from '../../types/configs/i18n-config';
import {languageOptions, shellLocale, initializeShellLanguage, shellText} from './shell-i18n';
import {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import type {Appearance} from './settings';
import { Avatar, Choice, Feedback, SwitchRow, TextField } from './components';
import {getTimeFormatter, readAutoTimeZone, readChatNewline, readChosenTimeZone, readContrast, readTimeFormat, readTimeZone, setAutoTimeZone, setChatNewline, setContrast, setTimeFormat, setTimeZone, subscribeDisplayPreferences, type Contrast, type TimeFormat} from './display-preferences';
import {getTimeZoneOptions} from './calendarcn/lib/time-zones';
import {TeamspaceIconPicker} from './cloud/teamspace-icon';
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
  /** Les espaces locaux n'ont pas d'identifiant à montrer : ils n'en ont pas. */
  workspaceId?: string;
  /** Absent hors d'un espace distant administré : il n'y a rien à renommer. */
  rename?(name: string): Promise<void>;
  /** Absent sans serveur : pas d'e-mail à autoriser, donc pas de réglage. */
  mail?: {read(): Promise<boolean>; write(allowed: boolean): Promise<void>};
  /** Absent là où rien ne peut la retenir : un espace sans registre ni base. */
  icon?: {value: string; write(icon: string): Promise<void>};
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

/** Le nom de l'espace, modifiable seulement là où un serveur peut l'écrire. */
function WorkspaceName({initial, rename}: {initial: string; rename(name: string): Promise<void>}) {
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();
  const changed = trimmed.length > 0 && trimmed !== saved;

  async function save() {
    setSaving(true);
    setNotice('');
    try {
      await rename(trimmed);
      // Le champ repart du nom retenu : sinon les espaces tapés autour
      // rouvriraient le bouton sur un enregistrement qui n'a rien à écrire.
      setSaved(trimmed);
      setValue(trimmed);
      setNotice(shellText("Nom enregistré."));
    } catch {
      setNotice(shellText("Le nom n’a pas pu être enregistré."));
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-panel-stack" data-setting="workspace-name">
    <div className="settings-panel-label">
      <strong>{shellText("Nom de l’espace de travail")}</strong>
      <small>{shellText("Jusqu’à 120 caractères. Tout le monde le voit dans la barre latérale.")}</small>
      {notice && <small role="status">{notice}</small>}
    </div>
    <TextField maxLength={120} value={value} data-desktop-settings-workspace-name=""
      aria-label={shellText("Nom de l’espace de travail")}
      onChange={event => setValue(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || !changed) return;
        event.preventDefault();
        void save();
      }}/>
    {/* Le bouton n'apparaît qu'avec quelque chose à enregistrer : un bouton
        éteint en permanence sous un champ ne dit rien à personne. */}
    {changed && <button type="button" data-desktop-settings-copy="" disabled={saving} onClick={() => void save()}>
      {shellText("Enregistrer")}
    </button>}
  </div>;
}

/**
 * L'icône de l'espace. Le sélecteur est celui des espaces d'équipe : même
 * jeu d'icônes, mêmes émojis, même import — et donc une seule chaîne stockée,
 * que les deux serveurs valident avec les mêmes bornes.
 */
function WorkspaceIcon({value, write, name}: NonNullable<General['icon']> & {name: string}) {
  const [icon, setIcon] = useState(value);
  const [notice, setNotice] = useState('');

  function choose(next: string) {
    const previous = icon;
    setIcon(next);
    setNotice('');
    write(next).catch(() => {
      setIcon(previous);
      setNotice(shellText("L’icône n’a pas pu être enregistrée."));
    });
  }

  return <div className="settings-panel-stack" data-setting="workspace-icon">
    <div className="settings-panel-label">
      <strong>{shellText("Icône")}</strong>
      <small>{shellText("Choisissez une icône ou un émoji, ou chargez une image. Elle apparaît dans la barre latérale.")}</small>
      {notice && <small role="status">{notice}</small>}
    </div>
    <div className="settings-panel-icon">
      <TeamspaceIconPicker value={icon} name={name} onChange={choose}
        label={shellText("Modifier l’icône de l’espace")}/>
    </div>
  </div>;
}

/** L'identifiant que le support et l'API demandent, avec de quoi le copier. */
function WorkspaceIdentifier({id}: {id: string}) {
  const [notice, setNotice] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setNotice(shellText("Identifiant copié"));
    } catch {
      setNotice(shellText("Copie impossible. Vous pouvez sélectionner l’identifiant."));
    }
  }
  return <div className="settings-panel-row" data-setting="workspace-id">
    <div className="settings-panel-label">
      <strong>{shellText("Identifiant de l’espace de travail")}</strong>
      <small><code>{id}</code></small>
      {notice && <small role="status">{notice}</small>}
    </div>
    <button type="button" data-desktop-settings-copy="" onClick={() => void copy()}>{shellText("Copier")}</button>
  </div>;
}

/**
 * Le commutateur d'espace : un administrateur coupe tous les e-mails de
 * notification d'un coup. Il s'affiche avant de connaître la réponse du
 * serveur, mais fermé — montrer une position avant de la savoir serait
 * annoncer un réglage au hasard.
 */
function WorkspaceMail({read, write}: NonNullable<General['mail']>) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const open = new AbortController();
    read().then(
      value => { if (!open.signal.aborted) setAllowed(value); },
      // Une lecture qui échoue ne doit pas annoncer « autorisé » : refusée par
      // défaut, le commutateur dira la vérité dès la prochaine ouverture.
      () => { if (!open.signal.aborted) setAllowed(false); });
    return () => open.abort();
  }, [read]);

  function toggle(next: boolean) {
    const previous = allowed;
    setAllowed(next);
    setNotice('');
    write(next).catch(() => {
      setAllowed(previous);
      setNotice(shellText("Le réglage n’a pas pu être enregistré."));
    });
  }

  return <>
    <SwitchRow settingId="workspace-mail" checked={allowed === true} disabled={allowed === null}
      label={shellText("Autoriser les notifications par e-mail dans l’espace")}
      help={shellText("Les membres peuvent toujours les désactiver individuellement.")}
      onChange={toggle}/>
    {notice && <p className="settings-notification-status" role="status">{notice}</p>}
  </>;
}

function GeneralPanel({workspace, version, remoteServer, workspaceId, rename, mail, icon}: General) {
  return <>
    <h1 data-desktop-settings-title="">{shellText("Général")}</h1>
    <p data-desktop-settings-intro="">{shellText("Gérez le nom de votre espace de travail et retrouvez ses informations.")}</p>
    <Section title={shellText("Espace de travail")}>
      {rename
        ? <WorkspaceName initial={workspace} rename={rename}/>
        : <dl className="settings-panel-values">
            <div data-setting="workspace-name"><dt>{shellText("Nom de l’espace")}</dt><dd>{workspace}</dd></div>
          </dl>}
      {icon && <WorkspaceIcon {...icon} name={workspace}/>}
      <dl className="settings-panel-values">
        <div data-setting="hosting"><dt>{shellText("Hébergement")}</dt><dd>{remoteServer ? shellText("Serveur distant") : shellText("Sur cet appareil")}</dd></div>
      </dl>
      {remoteServer && <details className="settings-panel-directory">
        <summary>{shellText("Adresse du serveur")}</summary>
        <code>{remoteServer}</code>
      </details>}
    </Section>
    {mail && <Section title={shellText("E-mails")}>
      <WorkspaceMail {...mail}/>
    </Section>}
    {workspaceId && <Section title={shellText("Identifiant")}>
      <WorkspaceIdentifier id={workspaceId}/>
    </Section>}
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
