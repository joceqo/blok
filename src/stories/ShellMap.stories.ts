import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import './shell-map.css';

interface Screen {
  name: string;
  path: string;
  stories?: [label: string, id: string][];
}

const groups: { title: string; screens: Screen[] }[] = [
  { title: 'Entrer dans Blok', screens: [
    { name: 'Créer le premier espace', path: 'Serveur vierge · espace et compte administrateur', stories: [
      ['Mot de passe', 'shell-accueil--creation-mot-de-passe'], ['Code par e-mail', 'shell-accueil--creation-par-email'],
    ] },
    { name: 'Se connecter', path: 'Serveur configuré · compte, code, changement de serveur', stories: [
      ['Connexion', 'shell-accueil--connexion'], ['Saisie du code', 'shell-accueil--verification-du-code'],
    ] },
    { name: 'Choisir ou rejoindre un espace', path: 'Après connexion · liste des espaces, création, invitation et demande d’accès' },
    { name: 'Travailler hors ligne', path: 'Tauri · menu des espaces → espace local' },
    { name: 'Serveur Docker local', path: 'Tauri → Paramètres → Connexions → Ouvrir le serveur local' },
    { name: 'Serveur injoignable', path: 'Connexion · réessayer ou changer de serveur' },
  ] },
  { title: 'Naviguer dans un espace', screens: [
    { name: 'Barre latérale', path: 'Espace → pages, sous-pages, favoris', stories: [['Arborescence', 'shell-sidebar--page-tree']] },
    { name: 'Recherche et pages récentes', path: 'Navigation → rechercher une page par titre ou rouvrir une page récente' },
    { name: 'Espaces d’équipe', path: 'Espace partagé → espaces d’équipe, membres et rôles' },
    { name: 'Notifications', path: 'Espace partagé → demandes d’accès et décisions', stories: [
      ['Boîte vide', 'shell-notifications--vide'], ['Non lues', 'shell-notifications--non-lues'],
    ] },
    { name: 'Corbeille', path: 'Menu des pages → corbeille de l’espace partagé → restaurer ou supprimer' },
  ] },
  { title: 'Travailler sur une page', screens: [
    { name: 'Page et sous-page', path: 'Page → fil d’Ariane, largeur et actions', stories: [
      ['Sous-page', 'shell-desktop-mise-en-page--sous-page'], ['Pleine largeur', 'shell-desktop-mise-en-page--pleine-largeur'],
    ] },
    { name: 'Icône et couverture', path: 'En-tête de page → icône, galerie et repositionnement', stories: [['Galerie', 'shell-desktop-couverture--galerie']] },
    { name: 'Mentions dans le titre', path: 'Titre de page → mentionner une page ou une date', stories: [['Page et date', 'shell-desktop-mentions--page-et-date']] },
    { name: 'Partage et permissions', path: 'Page partagée → Partager → visibilité et accès individuels' },
    { name: 'Historique', path: 'Actions de la page partagée → versions, changements et restauration' },
    { name: 'Déplacer une page', path: 'Menu de la page → choisir une destination dans l’arborescence' },
  ] },
  { title: 'Collaborer et administrer', screens: [
    { name: 'Membres', path: 'Paramètres de l’espace → membres, invitations, demandes et rôles' },
    { name: 'Compte et connexions', path: 'Paramètres → profil, autres espaces et accès MCP' },
    { name: 'Préférences et personnalisation', path: 'Paramètres → apparence, préférences de navigation et émojis' },
    { name: 'Assistant IA', path: 'Assistant → conversation, outils, activité et historique', stories: [
      ['Conversation', 'shell-agent--assistant'], ['Activité', 'shell-agent-composants-chat--activite'],
    ] },
    { name: 'Réglages IA', path: 'Paramètres → fournisseurs, modèles et clés' },
    { name: 'Administration de l’instance', path: 'Paramètres → Instance → général, accès, comptes, espaces, santé et e-mail' },
  ] },
];

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
}

function screenMap(): HTMLElement {
  const main = document.createElement('main');
  main.className = 'shell-screen-map';
  const heading = document.createElement('h1');
  heading.textContent = 'Carte du shell';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Rechercher un écran…';
  search.setAttribute('aria-label', 'Rechercher un écran');
  const list = document.createElement('div');
  const empty = document.createElement('p');
  empty.setAttribute('role', 'status');
  main.append(heading, search, empty, list);

  function render(): void {
    const query = normalize(search.value.trim());
    list.replaceChildren();
    for (const group of groups) {
      const matches = group.screens.filter(screen => normalize([group.title, screen.name, screen.path].join(' ')).includes(query));
      if (!matches.length) continue;
      const section = document.createElement('section');
      const title = document.createElement('h2');
      title.textContent = group.title;
      const rows = document.createElement('ul');
      for (const screen of matches) {
        const row = document.createElement('li');
        const label = document.createElement('strong');
        label.textContent = screen.name;
        const path = document.createElement('p');
        path.textContent = screen.path;
        row.append(label, path);
        if (screen.stories) {
          const links = document.createElement('div');
          for (const [name, id] of screen.stories) {
            const link = document.createElement('a');
            link.href = './?path=/story/' + id;
            link.target = '_top';
            link.textContent = name;
            links.append(link);
          }
          row.append(links);
        }
        rows.append(row);
      }
      section.append(title, rows);
      list.append(section);
    }
    empty.textContent = list.childElementCount ? '' : 'Aucun écran trouvé.';
  }
  search.addEventListener('input', render);
  render();
  return main;
}

export default { title: 'Shell/Carte', parameters: { layout: 'fullscreen' }, render: screenMap } satisfies Meta;
export const Ecrans: StoryObj = {
  name: 'Carte du shell',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole('searchbox');
    await userEvent.type(search, 'notifications');
    await expect(canvas.getByRole('link', { name: 'Non lues' })).toBeVisible();
    await expect(canvas.queryByText('Icône et couverture')).not.toBeInTheDocument();
    await userEvent.clear(search);
  },
};
