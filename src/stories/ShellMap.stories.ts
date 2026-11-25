import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { calendarJourneys, inboxJourneys, searchJourneys, shareJourneys, type Journey } from './shell-comparisons';
import './shell-map.css';

interface Screen {
  name: string;
  path: string;
  journeys?: Journey[];
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
    { name: 'Choisir ou rejoindre un espace', path: 'Après connexion · liste des espaces, création, invitation et demande d’accès', stories: [['Demander l’accès', 'shell-accueil--rejoindre-un-espace'], ['Demande en attente', 'shell-accueil--demande-en-attente']] },
    { name: 'Travailler hors ligne', path: 'Tauri · menu des espaces → espace local', stories: [['Profil sur disque', 'shell-parametres--profil-local']] },
    { name: 'Serveur Docker local', path: 'Tauri → Paramètres → Connexions → Ouvrir le serveur local' },
    { name: 'Serveur injoignable', path: 'Connexion · réessayer ou changer de serveur', stories: [['Serveur injoignable', 'shell-accueil--serveur-injoignable']] },
  ] },
  { title: 'Naviguer dans un espace', screens: [
    { name: 'Barre latérale', path: 'Espace → pages, sous-pages, favoris', stories: [['Arborescence', 'shell-sidebar--page-tree']] },
    { name: 'Recherche et pages récentes', journeys: searchJourneys, path: '⌘P / Ctrl+P → titres, contenu, filtres et pages récentes', stories: [['Pages récentes', 'shell-recherche--palette'], ['Dans le contenu', 'shell-recherche--dans-le-contenu']] },
    { name: 'Calendrier', journeys: calendarJourneys, path: 'Barre latérale → /calendar → agendas connectés, événements et pages associées', stories: [
      ['Agendas superposés', 'shell-calendrier--agendas-superposes'], ['Semaine', 'shell-calendrier--semaine'], ['Lecture seule', 'shell-calendrier--lecture-seule'], ['Planning', 'shell-calendrier--planning'],
    ] },
    { name: 'Espaces d’équipe', path: 'Espace partagé → espaces d’équipe → rechercher un espace et ses pages', stories: [['Répertoire', 'shell-equipes--repertoire']] },
    { name: 'Notifications', journeys: inboxJourneys, path: 'Espace partagé → demandes d’accès et décisions', stories: [
      ['Boîte vide', 'shell-notifications--vide'], ['Non lues', 'shell-notifications--non-lues'],
    ] },
    { name: 'Corbeille', path: 'Menu de l’espace → Corbeille → restaurer ou supprimer', stories: [['Pages supprimées', 'shell-corbeille--pages-supprimees'], ['Restauration', 'shell-corbeille--restauration']] },
  ] },
  { title: 'Travailler sur une page', screens: [
    { name: 'Page et sous-page', path: 'Page → fil d’Ariane, largeur et actions', stories: [
      ['Sous-page', 'shell-desktop-mise-en-page--sous-page'], ['Pleine largeur', 'shell-desktop-mise-en-page--pleine-largeur'],
    ] },
    { name: 'Icône et couverture', path: 'En-tête de page → icône, galerie et repositionnement', stories: [['Galerie', 'shell-desktop-couverture--galerie'], ['Galerie et sommaire', 'shell-desktop-couverture--galerie-et-sommaire']] },
    { name: 'Mentions dans le titre', path: 'Titre de page → mentionner une page ou une date', stories: [['Page et date', 'shell-desktop-mentions--page-et-date']] },
    { name: 'Partage et permissions', journeys: shareJourneys, path: 'Page partagée → Partager → visibilité et accès individuels', stories: [['Choisir un membre', 'shell-partage--choisir-un-membre'], ['Consultation', 'shell-partage--lecture-seule']] },
    { name: 'Historique', path: 'Actions de la page partagée → versions, changements et restauration' },
    { name: 'Déplacer une page', path: 'Menu de la page → choisir une destination dans l’arborescence' },
  ] },
  { title: 'Collaborer et administrer', screens: [
    { name: 'Membres', path: 'Paramètres de l’espace → membres, invitations, demandes et rôles' },
    { name: 'Compte et connexions', path: 'Paramètres → profil, autres espaces et accès MCP' },
    { name: 'Préférences et personnalisation', path: 'Paramètres → apparence et émojis', stories: [['Préférences', 'shell-parametres--preferences']] },
    { name: 'Assistant IA', path: 'Assistant → conversation, outils, activité et historique', stories: [
      ['Conversation', 'shell-agent--assistant'], ['Retrouver un brouillon', 'shell-agent--retrouver-un-brouillon'], ['Activité', 'shell-agent-composants-chat--activite'],
    ] },
    { name: 'Réglages IA', path: 'Paramètres → fournisseurs, modèles et clés' },
    { name: 'Administration de l’instance', path: 'Paramètres → Instance → général, accès, comptes, espaces, santé et e-mail' },
  ] },
];

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
}

function storyLink(label: string, id: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = './?path=/story/' + id;
  link.target = '_top';
  link.textContent = label;
  return link;
}

function screenMap(compare = false): HTMLElement {
  const main = document.createElement('main');
  main.className = 'shell-screen-map';
  const heading = document.createElement('h1');
  heading.textContent = compare ? 'Blok et Notion' : 'Carte du shell';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Rechercher un écran…';
  search.setAttribute('aria-label', 'Rechercher un écran');
  const list = document.createElement('div');
  const empty = document.createElement('p');
  empty.setAttribute('role', 'status');
  const nav = compare ? storyLink('← Carte du shell', 'shell-carte--ecrans') : storyLink('Comparer les parcours avec Notion →', 'shell-carte--comparaison');
  main.append(heading, nav);
  const filter = document.createElement('select');
  if (compare) {
    main.classList.add('shell-map-comparison');
    const note = document.createElement('p');
    note.textContent = 'Comparaison du shell web et desktop à partir de Blok et de l’aide officielle de Notion. Chaque constat porte sur une action précise.';
    filter.setAttribute('aria-label', 'Filtrer les parcours');
    for (const option of ['Parcours étudiés', 'Écarts', 'Comparable', 'Partiel', 'Manquant', 'Écrans à documenter']) filter.add(new Option(option));
    filter.addEventListener('change', render);
    main.append(note);
    search.placeholder = 'Rechercher un parcours…';
    search.setAttribute('aria-label', 'Rechercher un parcours');
  }
  const tools = document.createElement('div');
  tools.className = 'shell-map-tools';
  tools.append(search);
  if (compare) tools.append(filter);
  main.append(tools, empty, list);

  function render(): void {
    const query = normalize(search.value.trim());
    list.replaceChildren();
    for (const group of groups) {
      const matches = group.screens.flatMap(screen => {
        const context = [group.title, screen.name, screen.path].join(' ');
        const matchScreen = normalize(context).includes(query);
        if (!compare || filter.value === 'Écrans à documenter') {
          return matchScreen && (!compare || !screen.journeys) ? [{...screen, journeys: [] as Journey[]}] : [];
        }
        const journeys = screen.journeys?.filter(journey => {
          const mode = filter.value;
          const inFilter = mode === 'Parcours étudiés' || (mode === 'Écarts' && journey.status !== 'Comparable') || mode === journey.status;
          return inFilter && (matchScreen || normalize([journey.goal, journey.notion, journey.blok, journey.finding].join(' ')).includes(query));
        });
        return journeys?.length ? [{...screen, journeys}] : [];
      });
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
        for (const journey of screen.journeys) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          const badge = document.createElement('span');
          badge.dataset.status = journey.status;
          badge.textContent = journey.status;
          summary.append(journey.goal, badge);
          const paths = document.createElement('dl');
          for (const [product, steps] of [['Notion', journey.notion], ['Blok', journey.blok]]) {
            const term = document.createElement('dt');
            term.textContent = product;
            const description = document.createElement('dd');
            description.textContent = steps;
            paths.append(term, description);
          }
          const finding = document.createElement('p');
          finding.textContent = journey.finding;
          const source = document.createElement('a');
          source.href = journey.reference;
          source.target = '_blank';
          source.rel = 'noopener noreferrer';
          source.textContent = 'Référence Notion ↗';
          details.append(summary, paths, finding, source);
          row.append(details);
        }
        if (screen.stories) {
          const links = document.createElement('div');
          for (const [name, id] of screen.stories) {
            links.append(storyLink(name, id));
          }
          row.append(links);
        }
        rows.append(row);
      }
      section.append(title, rows);
      list.append(section);
    }
    if (compare && filter.value !== 'Écrans à documenter') {
      const total = list.querySelectorAll('details').length;
      empty.textContent = total ? total + (total === 1 ? ' parcours affiché' : ' parcours affichés') : 'Aucun parcours trouvé.';
    } else empty.textContent = list.childElementCount ? '' : 'Aucun écran trouvé.';
  }
  search.addEventListener('input', render);
  render();
  return main;
}

export default { title: 'Shell/Carte', parameters: { layout: 'fullscreen' }, render: () => screenMap() } satisfies Meta;
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

export const Comparaison: StoryObj = {
  name: 'Comparer avec Notion',
  render: () => screenMap(true),
};
