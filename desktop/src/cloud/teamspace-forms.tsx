import {shellText} from '../shell-i18n';
import {TEAM_ROLES} from '../access-vocabulary';
import {useState} from 'react';
import {TeamspaceIcon, TeamspaceIconPicker} from './teamspace-icon';
import {TeamspaceDialog, Alert} from './teamspace-dialog';
import {useResource, useTeamWrite, type Team, type TeamMember, type TeamClient, type TeamRole} from './teamspace-settings-data';
import type {CloudRole} from './client';

export function TeamEditor({client, base, team, workspace, firstDefault, onComplete, onClose}: {
  client: TeamClient; base: string; team?: Team; workspace: string; firstDefault: boolean;
  onComplete(team: Team): void; onClose(): void;
}) {
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [icon, setIcon] = useState(team?.icon ?? '');
  const {busy, error, write} = useTeamWrite(client);
  const title = team ? 'Modifier l’espace d’équipe' : 'Créer un espace d’équipe';
  const changed = !team || name.trim() !== team.name || description.trim() !== team.description || icon !== team.icon;
  return <TeamspaceDialog title={title} variant="editor" onClose={onClose} busy={busy}>
    <header className="teamspace-form-header">
      <span className="teamspace-emblem"><TeamspaceIcon value="icon:building" name="Équipe"/></span>
      <h2>{title}</h2><p>{shellText("Réunissez les pages de votre équipe et gérez ses membres.")}</p>
    </header>
    {firstDefault && <div className="teamspace-callout"><strong>{shellText("Créez le premier espace d’équipe de")} {workspace}.</strong>
      <p>{shellText("Les membres actuels et à venir y seront ajoutés automatiquement.")}</p></div>}
    <form onSubmit={event => {
      event.preventDefault();
      if (!changed || !name.trim()) return;
      const payload = {name: name.trim(), description: description.trim(), icon, ...(!team && firstDefault ? {makeDefault: true} : {})};
      void write<{teamspace: Team}>(team ? base + '/' + encodeURIComponent(team.id) : base, team ? 'PATCH' : 'POST', payload, result => onComplete(result.teamspace));
    }}>
      <label htmlFor="teamspace-editor-name">{shellText("Icône et nom")}</label><div className="teamspace-name-field">
        <TeamspaceIconPicker value={icon} name={name} onChange={setIcon} disabled={busy} label={shellText("Choisir une icône")}/>
        <input id="teamspace-editor-name" data-initial-focus="" required maxLength={120} value={name} placeholder={shellText("Par exemple, Ingénierie")} onChange={e => setName(e.target.value)}/>
      </div>
      <label htmlFor="teamspace-editor-description">{shellText("Description")}</label>
      <textarea id="teamspace-editor-description" maxLength={1000} value={description} placeholder={shellText("À quoi sert cet espace d’équipe ?")} onChange={e => setDescription(e.target.value)}/>
      <Alert message={error}/>
      <footer><button className="teamspace-primary" disabled={!changed || !name.trim() || busy}>{team ? shellText("Enregistrer") : shellText("Créer l’espace d’équipe")}</button></footer>
    </form>
  </TeamspaceDialog>;
}

interface Person {id: string; name?: string; email: string; role: CloudRole}
export function TeamInvite({client, base, team, fromCreation, onAdded, onClose}: {
  client: TeamClient; base: string; team: Team; fromCreation: boolean; onAdded(): void; onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [selected, setSelected] = useState<Person | null>(null);
  const path = base + '/' + encodeURIComponent(team.id) + '/members';
  const roster = useResource<{members: TeamMember[]}>(client, path);
  const directory = useResource<{members: Person[]}>(client, base.slice(0, -'/teamspaces'.length) + '/members');
  const {error, busy, write} = useTeamWrite(client);
  const candidates = directory.value?.members.filter(person => !roster.value?.members.some(member => member.userId === person.id));
  const filtered = candidates?.filter(person => (person.name + ' ' + person.email).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <TeamspaceDialog title={'Inviter dans ' + team.name} variant="invite" onClose={onClose} busy={busy}>
    <h2>{shellText("Inviter dans")} <span className="teamspace-title-icon"><TeamspaceIcon value={team.icon || ''} name={team.name}/></span> {team.name}</h2>
    <div className="teamspace-invite-input">
      <input type="search" data-initial-focus="" aria-label={shellText("Rechercher des personnes")} placeholder={shellText("Rechercher des personnes…")} value={selected ? selected.name || selected.email : query}
        onChange={event => {setSelected(null); setQuery(event.target.value);}}/>
      <select aria-label={shellText("Rôle dans l’équipe")} value={role} onChange={event => setRole(event.target.value as TeamRole)}>
        <option value="member">{TEAM_ROLES.member}</option><option value="owner" disabled={selected?.role === 'viewer'}>{TEAM_ROLES.owner}</option></select>
    </div>
    <Alert message={directory.error} retry={directory.reload}/><Alert message={roster.error} retry={roster.reload}/>
    {directory.value && roster.value && !selected && <div className="teamspace-candidates">
      {filtered?.map(person => <button key={person.id} type="button" onClick={() => {setSelected(person); if (person.role === 'viewer') setRole('member');}}>
        <span className="teamspace-avatar">{(person.name || person.email || '?').slice(0, 1).toUpperCase()}</span><span>{person.name || person.email || TEAM_ROLES.member}{person.email && person.name && <small>{person.email}</small>}</span>
      </button>)}
      {!filtered?.length && <p>{candidates?.length ? shellText("Aucune personne ne correspond à votre recherche.") : shellText("Tous les membres de cet espace de travail font déjà partie de l’équipe.")}</p>}
    </div>}
    <Alert message={error}/><footer>
      <button className="teamspace-outline" onClick={onClose} disabled={busy}>{fromCreation ? shellText("Passer pour le moment") : shellText("Annuler")}</button>
      {selected && <button className="teamspace-primary" disabled={busy} onClick={() => {void write(path, 'POST', {userId: selected.id, role}, onAdded);}}>{shellText("Ajouter à l’équipe")}</button>}
    </footer>
  </TeamspaceDialog>;
}
