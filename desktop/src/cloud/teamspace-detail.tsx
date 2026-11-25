import {TEAM_ROLES} from '../access-vocabulary';
import {useEffect, useId, useRef, useState} from 'react';
import {TeamspaceIcon, TeamspaceIconPicker} from './teamspace-icon';
import {TeamspaceDialog, Alert} from './teamspace-dialog';
import {useResource, useTeamWrite, teamError, type TeamClient, type Team, type TeamMember, type TeamRole} from './teamspace-settings-data';
import type {TeamPageNavigation} from './teamspaces';

type DetailTab = 'Général' | 'Membres' | 'Sécurité';
const tabs: DetailTab[] = ['Général', 'Membres', 'Sécurité'];
interface Page {id: string; title: string}

function TeamPages({client, path, navigation, canManage}: {client: TeamClient; path: string; navigation: TeamPageNavigation; canManage: boolean}) {
  const {value, error, reload} = useResource<{pages: Page[]}>(client, path);
  const mutation = useTeamWrite(client);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState('');
  const [navigationError, setNavigationError] = useState('');
  const signal = useRef<AbortController | null>(null);
  useEffect(() => () => signal.current?.abort(), []);
  const candidates = navigation.pages().filter(page => navigation.canEdit(page.id) && !value?.pages.some(item => item.id === page.id));
  async function open(id: string) {
    signal.current?.abort(); const current = new AbortController(); signal.current = current;
    try {await navigation.open(id, current.signal);} catch (cause) {if (!current.signal.aborted) setNavigationError(teamError(cause));}
  }
  return <section className="teamspace-detail-section"><h3>Pages de l’équipe</h3>
    <Alert message={error} retry={reload}/><Alert message={mutation.error || navigationError}/>
    {value && <>{value.pages.length ? value.pages.map(page => <div className="teamspace-setting-row" key={page.id}>
      <button className="teamspace-link-button" onClick={() => {void open(page.id);}}>{page.title || 'Sans titre'}</button>
      {canManage && navigation.canEdit(page.id) && <button className="teamspace-outline" disabled={mutation.busy} onClick={() => {
        void mutation.write(path + '/' + encodeURIComponent(page.id), 'DELETE', undefined, reload);
      }}>Détacher</button>}
    </div>) : <p>Aucune page accessible rattachée à cette équipe.</p>}
    {canManage && (choosing ? <form className="teamspace-page-form" onSubmit={e => {
      e.preventDefault(); if (!selected || !candidates.some(page => page.id === selected)) return;
      void mutation.write(path + '/' + encodeURIComponent(selected), 'PUT', undefined, () => {setChoosing(false); setSelected(''); reload();});
    }}>
      <select aria-label="Choisir une page" value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">{candidates.length ? 'Choisir une page…' : 'Aucune autre page modifiable'}</option>
        {candidates.map(page => <option key={page.id} value={page.id}>{page.title || 'Sans titre'}</option>)}</select>
      <button className="teamspace-outline" type="button" onClick={() => setChoosing(false)}>Annuler</button>
      <button className="teamspace-primary" disabled={!selected || mutation.busy}>Rattacher</button>
    </form> : <button className="teamspace-outline" onClick={() => setChoosing(true)}>Rattacher une page</button>)}</>}
  </section>;
}

function Roster({client, path, team, accountId, onInvite, onUpdate}: {
  client: TeamClient; path: string; team: Team; accountId: string; onInvite(): void; onUpdate(): void;
}) {
  const {value, error, reload} = useResource<{members: TeamMember[]}>(client, path);
  const mutation = useTeamWrite(client);
  const [query, setQuery] = useState('');
  const [removeId, setRemoveId] = useState('');
  const refresh = () => {setRemoveId(''); reload(); onUpdate();};
  const owners = value?.members.filter(member => member.role === 'owner').length ?? 0;
  const filtered = value?.members.filter(member => [member.name, member.email].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div><div className="teamspace-roster-toolbar">
    <input type="search" aria-label="Rechercher un membre" value={query} placeholder="Rechercher un membre…" onChange={e => setQuery(e.target.value)}/>
    {team.canManage && <button className="teamspace-primary" onClick={onInvite}>Ajouter des membres</button>}
  </div>
  <Alert message={error} retry={reload}/><Alert message={mutation.error}/>
  <table className="teamspace-roster"><thead><tr><th>Nom</th><th>Rôle</th></tr></thead><tbody>
    {filtered?.map(member => {
      const name = member.name || member.email || (accountId === member.userId ? 'Profil local' : TEAM_ROLES.member);
      const lastOwner = owners === 1 && member.role === 'owner';
      const memberPath = path + '/' + encodeURIComponent(member.userId);
      return <tr key={member.userId}><td><div className="teamspace-person"><span className="teamspace-avatar">{name.slice(0, 1).toUpperCase()}</span>
        <span>{name}{member.userId === accountId && ' (vous)'}{member.workspaceRole === 'admin' && <small className="teamspace-pill">Admin</small>}
        {member.name && member.email && <small>{member.email}</small>}</span></div></td><td>
        {removeId === member.userId ? <><button className="teamspace-outline" onClick={() => setRemoveId('')}>Annuler</button>{' '}
          <button className="teamspace-danger" disabled={mutation.busy} onClick={() => {void mutation.write(memberPath, 'DELETE', undefined, refresh);}}>Confirmer le retrait</button></> :
        team.canManage && !lastOwner ? <select value={member.role} aria-label={'Rôle de ' + name} disabled={mutation.busy}
          onChange={e => {const role = e.target.value; if (role === 'remove') setRemoveId(member.userId); else void mutation.write(memberPath, 'PATCH', {role: role as TeamRole}, refresh);}}>
          <option value="member">{TEAM_ROLES.member}</option><option value="owner" disabled={member.workspaceRole === 'viewer'}>{TEAM_ROLES.owner}</option>
          {!team.isDefault && <option value="remove">Retirer de l’équipe</option>}</select> :
          TEAM_ROLES[member.role]}
      </td></tr>;
    })}
    {value && !filtered?.length && <tr><td colSpan={2} className="teamspace-empty">{query ? 'Aucun membre ne correspond à votre recherche.' : 'Aucun membre dans cette équipe.'}</td></tr>}
  </tbody></table></div>;
}

export function TeamDetail({client, base, team, navigation, accountId, initialTab, onInvite, onEdit, onUpdate, onClose}: {
  client: TeamClient; base: string; team: Team; navigation: TeamPageNavigation; accountId: string; initialTab: DetailTab;
  onInvite(): void; onEdit(): void; onUpdate(): void; onClose(): void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [deleting, setDeleting] = useState(false);
  const mutation = useTeamWrite(client);
  const id = useId();
  const path = base + '/' + encodeURIComponent(team.id);
  return <TeamspaceDialog title={team.name} variant="detail" onClose={onClose} busy={mutation.busy}>
    <div className="teamspace-detail-logo">
      {team.canManage ? <TeamspaceIconPicker value={team.icon || ''} name={team.name} label={'Changer l’icône de ' + team.name} disabled={mutation.busy} onChange={icon => {
        void mutation.write(path, 'PATCH', {icon}, onUpdate);
      }}/> : <TeamspaceIcon value={team.icon || ''} name={team.name}/>}
    </div>
    <h2>{team.name}{team.canManage && <button aria-label="Modifier l’espace d’équipe" className="teamspace-edit" onClick={onEdit}>✎</button>}</h2>
    <div className="teamspace-detail-sub"><span>{team.memberCount} membre{team.memberCount > 1 ? 's' : ''}</span>{team.joined && <span className="teamspace-pill">✓ {TEAM_ROLES.member}</span>}</div>
    <div role="tablist" aria-label="Réglages de l’équipe" className="teamspace-tabs">
      {tabs.map((item, i) => <button key={item} role="tab" id={id + '-tab-' + i} aria-controls={id + '-panel'} tabIndex={item === tab ? 0 : -1}
        aria-selected={item === tab} onClick={() => setTab(item)} onKeyDown={e => {
          const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
          if (next >= 0) {e.preventDefault(); setTab(tabs[next]); document.getElementById(id + '-tab-' + next)?.focus();}
        }}>{item}</button>)}
    </div>
    <Alert message={mutation.error}/>
    <div role="tabpanel" id={id + '-panel'} aria-labelledby={id + '-tab-' + tabs.indexOf(tab)}>
      {tab === 'Général' && <>
        {team.description && <p className="teamspace-description">{team.description}</p>}
        <TeamPages client={client} path={path + '/pages'} navigation={navigation} canManage={team.canManage}/>
      </>}
      {tab === 'Membres' && <Roster client={client} path={path + '/members'} team={team} accountId={accountId} onInvite={onInvite} onUpdate={onUpdate}/>}
      {tab === 'Sécurité' && <section className="teamspace-detail-section"><h3>Adhésion à l’équipe</h3>
        <p>{team.isDefault ? 'Tous les membres actuels et à venir de l’espace de travail rejoignent cette équipe.' : 'Les propriétaires et les administrateurs peuvent ajouter des membres de l’espace de travail.'}</p>
        <h3>Droits des pages</h3><p>Les autorisations de chaque page se règlent dans son menu Partager.</p>
        {team.canManage && (deleting ? <div className="teamspace-delete-confirm"><strong>Supprimer « {team.name} » ?</strong>
          <p>Ses membres et les liens vers ses pages seront retirés. Les pages resteront dans l’espace de travail.</p>
          <button className="teamspace-outline" onClick={() => setDeleting(false)} disabled={mutation.busy}>Annuler</button>{' '}
          <button className="teamspace-danger" disabled={mutation.busy} onClick={() => {
            void mutation.write(path, 'DELETE', undefined, () => {onClose(); onUpdate();});
          }}>Confirmer la suppression</button></div> : <button className="teamspace-danger" onClick={() => setDeleting(true)}>Supprimer l’espace d’équipe</button>)}
      </section>}
    </div>
  </TeamspaceDialog>;
}
