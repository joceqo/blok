import {TEAM_ROLES} from '../access-vocabulary';
import {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {IconPeople, IconSearch, IconCheck, IconChevronDown, IconLock, IconSliders} from '../../../src/components/icons';
import type {RemoteWorkspace} from '../workspace-registry';
import type {TeamPageNavigation} from './teamspaces';
import {TeamspaceIcon} from './teamspace-icon';
import {Alert} from './teamspace-dialog';
import {TeamDetail} from './teamspace-detail';
import {TeamEditor, TeamInvite} from './teamspace-forms';
import {useResource, useTeamWrite, type TeamClient, type Team, type Directory} from './teamspace-settings-data';
import './teamspace-settings.css';

type Scene = {kind: 'create'} | {kind: 'edit' | 'detail' | 'invite'; team: Team; fromCreation?: boolean; tab?: 'Général' | 'Membres' | 'Sécurité'};
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().trim();

function Defaults({client, base, teams, reload}: {client: TeamClient; base: string; teams: Team[]; reload():void}) {
  const defaults = teams.filter(team => team.isDefault).map(team => team.id);
  const [draft, setDraft] = useState<string[] | null>(null);
  const selected = draft ?? defaults;
  const {busy, error, write} = useTeamWrite(client);
  const changed = selected.length !== defaults.length || selected.some(id => !defaults.includes(id));
  return <section className="teamspace-policy">
    <h2>Espaces d’équipe par défaut</h2>
    <p>Choisissez les équipes que les membres actuels et à venir rejoignent automatiquement.</p>
    <div className="teamspace-default-form"><div className="teamspace-default-field">
      {teams.filter(team => selected.includes(team.id)).map(team => <button key={team.id} type="button" disabled={busy}
        aria-label={'Retirer ' + team.name + ' des espaces par défaut'} onClick={() => setDraft(selected.filter(id => id !== team.id))}>
        <TeamspaceIcon value={team.icon || ''} name={team.name}/>{team.name}<span aria-hidden="true">×</span></button>)}
      {teams.some(team => !selected.includes(team.id)) && <select value="" aria-label="Ajouter un espace par défaut" disabled={busy}
        onChange={event => {if (event.target.value) setDraft([...selected, event.target.value]);}}>
        <option value="">{selected.length ? 'Ajouter…' : 'Choisir des espaces…'}</option>
        {teams.filter(team => !selected.includes(team.id)).map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select>}
    </div><button className="teamspace-primary" disabled={!changed || busy} onClick={() => {
      void write(base + '/settings', 'PATCH', {defaultTeamspaceIds: selected}, reload);
    }}>Mettre à jour</button></div><Alert message={error}/>
  </section>;
}

function Filter({label, value, onChange, options, icon}: {
  label: string; value: string; onChange(value: string): void; options: [string, string][]; icon: string;
}) {
  return <label className="teamspace-filter" data-active={value !== ''}>
    <span aria-hidden="true" dangerouslySetInnerHTML={{__html: icon}}/>
    <span aria-hidden="true">{options.find(([key]) => key === value)?.[1]}</span>
    <span aria-hidden="true" dangerouslySetInnerHTML={{__html: IconChevronDown}}/>
    <select value={value} aria-label={label} onChange={event => onChange(event.target.value)}>
      {options.map(([key,text]) => <option value={key} key={key}>{text}</option>)}
    </select>
  </label>;
}

function Panel({client, workspace, navigation}: {client: TeamClient; workspace: RemoteWorkspace; navigation: TeamPageNavigation}) {
  const base = '/api/workspaces/' + encodeURIComponent(workspace.workspaceId) + '/teamspaces';
  const directory = useResource<Directory>(client, base);
  const mutation = useTeamWrite(client);
  const [scene, setScene] = useState<Scene | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [membership, setMembership] = useState('');
  const [owner, setOwner] = useState('');
  const [access, setAccess] = useState('');
  const [management, setManagement] = useState('');
  const [ascending, setAscending] = useState(false);
  const data = directory.value;
  const openCreation = useRef(navigation.initialView === 'create');
  useEffect(() => {
    if (!openCreation.current || !data) return;
    openCreation.current = false;
    if (data.canCreate) setScene({kind: 'create'});
  }, [data]);
  const teams = data?.teamspaces ?? [];
  const admin = workspace.role === 'admin';
  const selectedTeam = scene && scene.kind !== 'create' ? teams.find(team => team.id === scene.team.id) ?? scene.team : undefined;
  const owners = new Map(teams.flatMap(team => (team.owners ?? []).map(person => [person.userId, person.name || person.email || 'Profil local'] as const)));
  const filtered = teams.filter(team => fold(team.name).includes(fold(query)) && (!membership || team.joined === (membership === 'joined')) &&
    (!owner || team.owners?.some(person => person.userId === owner)) && (!access || team.isDefault === (access === 'default')) &&
    (!management || team.canManage === (management === 'edit')))
    .sort((a,b) => (String(a.updatedAt).localeCompare(String(b.updatedAt)) || a.name.localeCompare(b.name)) * (ascending ? 1 : -1));
  function close() {
    setScene(null);
    const trigger = returnFocus.current;
    returnFocus.current = null;
    queueMicrotask(() => {if (trigger?.isConnected) trigger.focus();});
  }
  function see(team: Team, tab: 'Général' | 'Membres' | 'Sécurité' = 'Membres') {setScene({kind: 'detail', team, tab});}
  const refresh = directory.reload;

  return <div className="teamspace-settings"><h1 data-desktop-settings-title="">Espaces d’équipe</h1>
    <p data-desktop-settings-intro="">Gérez les espaces d’équipe de votre espace de travail.</p>
    <Alert message={directory.error} retry={refresh}/>
    {!data && !directory.error && <p role="status">Chargement des espaces d’équipe…</p>}
    {data && <>
      {admin && teams.length > 0 && data.settings && <Defaults client={client} base={base} teams={teams} reload={refresh}
        key={teams.filter(team => team.isDefault).map(team => team.id).sort().join('|')}/>}
      {admin && data.settings && <div className="teamspace-policy teamspace-setting-row">
        <div><h2 id="teamspace-creation-policy">Réserver la création aux administrateurs</h2>
          <p>Seuls les administrateurs de cet espace de travail pourront créer des espaces d’équipe.</p></div>
        <button type="button" className="settings-panel-switch" role="switch" aria-checked={data.settings.restrictCreation}
          aria-labelledby="teamspace-creation-policy" disabled={mutation.busy} onClick={() => {
            void mutation.write(base + '/settings', 'PATCH', {restrictCreation: !data.settings.restrictCreation}, refresh);
          }}/></div>}
      <Alert message={mutation.error}/>
      <section className="teamspace-directory"><h2>Espaces d’équipe</h2><p>Retrouvez ici les équipes auxquelles vous avez accès.</p>
        <div className="teamspace-toolbar">
          <Filter label="Filtrer par adhésion" icon={IconCheck} value={membership} onChange={setMembership} options={[['','Adhésion'],['joined','Mes équipes'],['other','Autres équipes']]}/>
          <Filter label="Filtrer par propriétaire" icon={IconPeople} value={owner} onChange={setOwner} options={[['','Propriétaire'], ...Array.from(owners)]}/>
          <Filter label="Filtrer par accès" icon={IconLock} value={access} onChange={setAccess} options={[['','Accès'],['default','Par défaut'],['invite','Sur invitation']]}/>
          <Filter label="Filtrer par droits de gestion" icon={IconSliders} value={management} onChange={setManagement} options={[['','Droits'],['edit','Gestion autorisée'],['read','Consultation']]}/>
          <span className="teamspace-toolbar-spacer"/>
          <button type="button" className="teamspace-icon-button" title="Rechercher" aria-label="Rechercher un espace d’équipe" aria-expanded={searching}
            onClick={() => {setSearching(!searching); setQuery('');}} dangerouslySetInnerHTML={{__html: IconSearch}}/>
          {data.canCreate && <button className="teamspace-primary" onClick={event => {returnFocus.current = event.currentTarget; setScene({kind:'create'});}}>Nouvel espace d’équipe</button>}
        </div>
        {searching && <input className="teamspace-search" type="search" aria-label="Nom de l’espace d’équipe" autoFocus placeholder="Rechercher un espace d’équipe…" value={query} onChange={e => setQuery(e.target.value)}/>}
        <div className="teamspace-scroll-table"><table className="teamspace-table"><thead><tr>
          <th>Espace d’équipe</th><th>Propriétaires</th><th>Accès</th>
          <th aria-sort={ascending ? 'ascending' : 'descending'}><button onClick={() => setAscending(!ascending)}>Mis à jour {ascending ? '↑' : '↓'}</button></th><th aria-label="Actions"/>
        </tr></thead><tbody>{filtered.map(team => <tr key={team.id} onClick={event => {returnFocus.current = event.currentTarget.querySelector('button'); see(team);}}>
          <td><button className="teamspace-row-button" onClick={event => {event.stopPropagation(); returnFocus.current = event.currentTarget; see(team);}}>
            <span className="teamspace-row-icon"><TeamspaceIcon value={team.icon || ''} name={team.name}/></span>
            <span>{team.name}<small>{typeof team.memberCount === 'number' && <>{team.memberCount} membre{team.memberCount > 1 ? 's' : ''}</>}{team.joined && ' · ' + TEAM_ROLES.member}</small></span>
          </button></td>
          <td>{team.owners?.length ? <div className="teamspace-person"><span className="teamspace-avatar">{(team.owners[0].name || team.owners[0].email || '?').slice(0,1).toUpperCase()}</span><span>{team.owners.map(p => p.name || p.email || 'Profil local').join(', ')}</span></div> : '—'}</td>
          <td>{team.isDefault ? 'Par défaut' : 'Sur invitation'}</td><td>{team.updatedAt && <time dateTime={team.updatedAt}>{new Date(team.updatedAt).toLocaleDateString('fr-FR')}</time>}</td>
          <td><button className="teamspace-more" aria-label={'Paramètres de ' + team.name} onClick={event => {event.stopPropagation(); returnFocus.current = event.currentTarget; see(team, 'Général');}}>•••</button></td>
        </tr>)}
        {!filtered.length && <tr><td colSpan={5} className="teamspace-empty">{teams.length ? 'Aucun espace d’équipe ne correspond aux filtres.' : 'Aucun espace d’équipe.'}</td></tr>}
        </tbody></table></div>
      </section>
    </>}
    {scene?.kind === 'create' && <TeamEditor client={client} base={base} workspace={workspace.name} firstDefault={admin && teams.length === 0}
      onClose={close} onComplete={team => {refresh(); setScene({kind:'invite', team, fromCreation:true});}}/>}
    {scene?.kind === 'edit' && selectedTeam && <TeamEditor client={client} base={base} team={selectedTeam} workspace={workspace.name} firstDefault={false}
      onClose={() => see(selectedTeam, 'Général')} onComplete={team => {refresh(); see(team, 'Général');}}/>}
    {scene?.kind === 'invite' && selectedTeam && <TeamInvite client={client} base={base} team={selectedTeam} fromCreation={!!scene.fromCreation}
      onClose={() => scene.fromCreation ? close() : see(selectedTeam)} onAdded={() => {refresh(); see(selectedTeam);}}/>}
    {scene?.kind === 'detail' && selectedTeam && <TeamDetail client={client} base={base} team={selectedTeam} navigation={navigation} accountId={workspace.accountId} initialTab={scene.tab ?? 'Membres'}
      onClose={close} onUpdate={refresh} onInvite={() => setScene({kind:'invite',team:selectedTeam})} onEdit={() => setScene({kind:'edit',team:selectedTeam})}/>}
  </div>;
}

export function mountTeamspaceSettings(host: HTMLElement, workspace: RemoteWorkspace, navigation: TeamPageNavigation, client: TeamClient) {
  const root = createRoot(host);
  flushSync(() => root.render(<Panel client={client} workspace={workspace} navigation={navigation}/>));
  return () => {root.unmount(); navigation.onClose?.();};
}
