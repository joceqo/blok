import {shellText} from './shell-i18n';
import type { CloudRole, CloudSignupPolicy, CloudWorkspaceCreation } from './cloud/client';
import type { PageLevel } from './page-access';
import type { ChoiceOption } from './components/dom';

/** Libellés d’espace affichés aujourd’hui dans gateway, réglages et invitation. */
export const WORKSPACE_ROLES: Record<CloudRole, string> = {
  admin: shellText("Administrateur"),
  member: shellText("Membre"),
  viewer: shellText("Lecture seule"),
};

export const TEAM_ROLES = { member: WORKSPACE_ROLES.member, owner: shellText("Propriétaire") } as const;

/** Conséquences affichées en seconde ligne des sélecteurs de rôle. */
export const WORKSPACE_ROLE_DESCRIPTIONS: Record<CloudRole, string> = {
  admin: shellText("Gère les membres, les réglages et toutes les pages de l’espace."),
  member: shellText("Peut créer et modifier les pages de l’espace."),
  viewer: shellText("Consulte les pages ouvertes à l’espace, sans les modifier."),
};

/** Libellés de niveau de page affichés dans la feuille de partage. */
export const PAGE_LEVELS: Record<PageLevel, string> = {
  view: shellText("Peut voir"),
  edit: shellText("Peut modifier"),
  full: shellText("Accès complet"),
};

/** Conséquences affichées en seconde ligne des sélecteurs de niveau. */
export const PAGE_LEVEL_DESCRIPTIONS: Record<PageLevel, string> = {
  view: shellText("Peut ouvrir et lire cette page."),
  edit: shellText("Peut modifier le contenu de cette page."),
  full: shellText("Peut partager et gérer les accès de cette page."),
};

/**
 * Plafond rôle × page (plan §11). Un viewer d’espace reste plafonné à la lecture
 * même si un partage lui offre l’édition — `capOf` côté serveur.
 */
export const PAGE_RIGHTS_CUMULATIVE =
  'Les droits d’une page s’ajoutent à ceux de l’espace : un lecteur de l’espace ne peut pas modifier une page, même partagée en modification.';

/** En-tête du panneau Membres — les trois rôles en une phrase. */
export const MEMBERS_ROLES_INTRO =
  `${WORKSPACE_ROLES.admin} gère l’espace, ${WORKSPACE_ROLES.member} crée et modifie, ${WORKSPACE_ROLES.viewer} consulte. Un partage de page ne dépasse jamais ce rôle.`;

/** Politique d’inscription — libellé + conséquence (plan §9.2 / §9.3). */
export const SIGNUP_POLICIES: Record<CloudSignupPolicy, {label: string; consequence: string}> = {
  invite: {
    label: shellText("Sur invitation"),
    consequence: shellText("Invitation seule — personne ne crée de compte sans y être invité."),
  },
  domain: {
    label: shellText("Domaines autorisés"),
    consequence: shellText("Seules les adresses des domaines listés peuvent créer un compte."),
  },
  open: {
    label: shellText("Ouverte"),
    consequence: shellText("Toute adresse e-mail peut créer un compte sur cette instance."),
  },
};

/** Qui peut créer un espace — libellé + conséquence. */
export const WORKSPACE_CREATION_POLICIES: Record<CloudWorkspaceCreation, {label: string; consequence: string}> = {
  anyone: {
    label: shellText("Tout le monde"),
    consequence: shellText("Chaque personne connectée peut créer un espace de travail."),
  },
  admins_only: {
    label: shellText("Administrateurs d’instance"),
    consequence: shellText("Seuls les administrateurs d’instance peuvent créer un espace."),
  },
  disabled: {
    label: shellText("Désactivée"),
    consequence: shellText("Personne ne crée d’espace depuis le client ; les administrateurs passent par l’API d’administration."),
  },
};

/** Options du sélecteur de rôle d’espace, dans l’ordre historique. */
export function roleOptions(admin = true): ChoiceOption<CloudRole>[] {
  const values = (admin ? ['member', 'viewer', 'admin'] : ['member', 'viewer']) as CloudRole[];
  return values.map((value) => ({
    value,
    label: WORKSPACE_ROLES[value],
    description: WORKSPACE_ROLE_DESCRIPTIONS[value],
  }));
}

/** Options du sélecteur de niveau de page. */
export function pageLevelOptions(): ChoiceOption<PageLevel>[] {
  return (['view', 'edit', 'full'] as PageLevel[]).map((value) => ({
    value,
    label: PAGE_LEVELS[value],
    description: PAGE_LEVEL_DESCRIPTIONS[value],
  }));
}

/** Options `createChoice` pour la politique d’inscription. */
export function signupPolicyOptions(): ChoiceOption<CloudSignupPolicy>[] {
  return (['invite', 'domain', 'open'] as CloudSignupPolicy[]).map((value) => ({
    value,
    label: SIGNUP_POLICIES[value].label,
    description: SIGNUP_POLICIES[value].consequence,
  }));
}

/** Options `createChoice` pour la création d’espaces. */
export function workspaceCreationOptions(): ChoiceOption<CloudWorkspaceCreation>[] {
  return (['anyone', 'admins_only', 'disabled'] as CloudWorkspaceCreation[]).map((value) => ({
    value,
    label: WORKSPACE_CREATION_POLICIES[value].label,
    description: WORKSPACE_CREATION_POLICIES[value].consequence,
  }));
}
