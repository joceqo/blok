import {shellText} from '../shell-i18n';
import { FooterIcon } from './footer-icon';
import {
  Avatar,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../components';
import { workspaceKey, type WorkspaceRef, type RemoteWorkspace } from '../workspace-registry';

export interface FooterChoices {
  current: WorkspaceRef;
  groups: Map<string, RemoteWorkspace[]>;
  locals?: WorkspaceRef[];
  webAccount: RemoteWorkspace | null;
  offlineProfile: boolean;
  invite?: () => void;
  connect(): void;
  select(workspace: WorkspaceRef): void;
  createLocal(): void;
  createRemote(): void;
  logout(): void;
}

interface WorkspaceChoiceProps {
  workspace: WorkspaceRef;
  current: WorkspaceRef;
  select(workspace: WorkspaceRef): void;
}

const WorkspaceChoice = ({ workspace, current, select }: WorkspaceChoiceProps) => {
  const active = workspaceKey(workspace) === workspaceKey(current);
  return (
    <DropdownMenuRadioItem
      value={workspaceKey(workspace)}
      aria-current={active ? 'true' : undefined}
      data-desktop-menu-workspace=""
      data-desktop-menu-item=""
      onClick={() => select(workspace)}
    >
      <Avatar
        data-desktop-workspace-avatar=""
        name={workspace.name}
      />
      <span data-desktop-menu-workspace-name="">{workspace.name}</span>
      {active && (
        <span
          aria-hidden="true"
          data-desktop-menu-check=""
        >
          ✓
        </span>
      )}
    </DropdownMenuRadioItem>
  );
};

interface WorkspaceChoicesProps {
  choices: FooterChoices;
  allowCreation: boolean;
}

// Chaque groupe correspond à un compte. Les espaces locaux ont leur propre groupe sur cet appareil.
export const WorkspaceChoices = ({ choices, allowCreation }: WorkspaceChoicesProps) => {
  const { current, groups, locals, webAccount } = choices;
  const list = (workspaces: WorkspaceRef[]) =>
    workspaces.map((workspace) => (
      <WorkspaceChoice
        key={workspaceKey(workspace)}
        workspace={workspace}
        current={current}
        select={choices.select}
      />
    ));
  return (
    <>
      {choices.invite && (
        <DropdownMenuItem
          data-desktop-menu-item=""
          data-desktop-menu-invite=""
          onClick={choices.invite}
        >
          <FooterIcon name="people" />
          {shellText("Inviter des membres")}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        data-desktop-menu-item=""
        data-desktop-menu-connect=""
        onClick={choices.connect}
      >
        <FooterIcon name="profile" />
        {choices.offlineProfile ? shellText("Se connecter à un serveur distant") : shellText("Ajouter un compte")}
      </DropdownMenuItem>
      {Array.from(groups, ([email, workspaces]) => (
        <fieldset
          key={email}
          data-desktop-menu-group=""
          aria-label={email}
        >
          <div data-desktop-menu-group-label="">{email}</div>
          <DropdownMenuRadioGroup value={workspaceKey(current)}>
            {list(workspaces)}
          </DropdownMenuRadioGroup>
          {allowCreation &&
            webAccount &&
            workspaces.some((w) => workspaceKey(w) === workspaceKey(webAccount)) && (
              <DropdownMenuItem
                data-desktop-menu-new-workspace=""
                data-desktop-menu-item=""
                onClick={choices.createRemote}
              >
                <FooterIcon name="add" />
                {shellText("Nouvel espace")}
              </DropdownMenuItem>
            )}
        </fieldset>
      ))}
      {locals && (
        <fieldset
          data-desktop-menu-group=""
          aria-label={shellText("Sur cet appareil")}
        >
          <div data-desktop-menu-group-label="">{shellText("Sur cet appareil")}</div>
          <DropdownMenuRadioGroup value={workspaceKey(current)}>
            {list(locals)}
          </DropdownMenuRadioGroup>
          <DropdownMenuItem
            data-desktop-menu-new-workspace=""
            data-desktop-menu-item=""
            onClick={choices.createLocal}
          >
            <FooterIcon name="add" />
            {shellText("Créer un espace local")}
          </DropdownMenuItem>
        </fieldset>
      )}
      {webAccount && (
        <div data-desktop-menu-group="">
          <DropdownMenuItem
            data-desktop-menu-logout=""
            data-desktop-menu-item=""
            onClick={choices.logout}
          >
            {shellText("Se déconnecter")}
          </DropdownMenuItem>
        </div>
      )}
    </>
  );
};
