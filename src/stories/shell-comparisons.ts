export interface Journey {
  goal: string;
  status: 'Comparable' | 'Partiel' | 'Manquant';
  notion: string;
  blok: string;
  finding: string;
  reference: string;
}

const search = 'https://www.notion.com/help/search';
const inbox = 'https://www.notion.com/help/updates-and-notifications';
const calendar = 'https://www.notion.com/help/use-notion-calendar-with-notion';

export const searchJourneys: Journey[] = [
  { goal: 'Rouvrir une page récente', status: 'Comparable', notion: 'Barre latérale → Recherche → pages récentes → page.',
    blok: '⌘P ou Rechercher → pages regroupées par date de visite → Entrée.',
    finding: 'Dans les deux produits, on peut retrouver la page avant même de saisir un mot.', reference: search },
  { goal: 'Retrouver une page écrite par une personne', status: 'Partiel', notion: 'Recherche → saisir un terme → filtrer par auteur.',
    blok: 'Recherche → saisir un terme → filtrer sur le titre ou sur une branche de pages.',
    finding: 'La recherche fonctionne. Il manque le choix d’un auteur pour départager des pages au titre similaire.', reference: search },
];

export const inboxJourneys: Journey[] = [
  { goal: 'Lire les notifications en continuant à écrire', status: 'Comparable', notion: 'Boîte de réception → épingler le volet → reprendre la saisie dans la page.',
    blok: 'Icône Notifications → épingle → reprendre la saisie dans la page.',
    finding: 'Le volet reste visible pendant la saisie sur ordinateur.', reference: inbox },
  { goal: 'Retrouver la discussion où l’on a été mentionné', status: 'Manquant', notion: 'Mention dans un commentaire → notification → discussion sur la page.',
    blok: 'Le volet présente les demandes d’accès à l’espace et les décisions associées.',
    finding: 'Il manque la notification de mention avec un lien vers le fil concerné.', reference: inbox },
];

export const calendarJourneys: Journey[] = [
  { goal: 'Afficher deux espaces dans le même agenda', status: 'Comparable', notion: 'Notion Calendar → réglages → connecter chaque espace → ajouter les bases datées à afficher.',
    blok: 'Calendrier → Mes espaces → Ajouter un espace → afficher ses événements.',
    finding: 'La grille peut réunir deux espaces. Notion y expose des bases sélectionnées, Blok les événements des agendas connectés.', reference: calendar },
  { goal: 'Créer un rendez-vous sur un créneau', status: 'Comparable', notion: 'Grille → sélectionner un créneau → renseigner les détails de l’événement.',
    blok: 'Grille → cliquer ou glisser → choisir l’agenda de destination → Enregistrer.',
    finding: 'Le créneau choisi préremplit les horaires. La comparaison porte sur la création simple, sans invitation de participants.', reference: 'https://www.notion.com/help/manage-your-calendars-and-events' },
  { goal: 'Afficher les échéances d’une base dans l’agenda', status: 'Manquant', notion: 'Agenda → espace connecté → ajouter une base → choisir sa propriété Date.',
    blok: 'Une base dispose de sa vue calendrier. Dans l’agenda général, on peut créer un événement et lui associer une page.',
    finding: 'La date d’une ligne de base ne remonte pas automatiquement dans l’agenda général. C’est la liaison à construire.', reference: calendar },
];

export const shareJourneys: Journey[] = [
  { goal: 'Donner à un membre l’accès à une page', status: 'Comparable', notion: 'Page → Partager → choisir la personne → attribuer un niveau d’accès.',
    blok: 'Page d’un espace partagé → Partager → choisir un membre de l’espace et son niveau d’accès.',
    finding: 'Le parcours donne un accès individuel à un membre existant. Les invités externes relèvent d’un autre parcours.', reference: 'https://www.notion.com/help/sharing-and-permissions' },
];
