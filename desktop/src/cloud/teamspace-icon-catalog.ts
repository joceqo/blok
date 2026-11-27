import {shellText} from '../shell-i18n';
import * as glyphs from '../../../src/components/icons';

const home = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m1.6 7 6.4-5.3L14.4 7l-1.5.2V14H9.5V9H6.6v5H3.1V7.2z"/></svg>';

// Only these application-owned drawings can be rendered as markup.
export const teamspaceSymbols = [
  ['building', 'Bâtiment', glyphs.IconBuilding], ['home', 'Maison', home], ['people', 'Équipe', glyphs.IconPeople], ['library', 'Bibliothèque', glyphs.IconLibrary],
  ['bookmark', 'Marque-page', glyphs.IconBookmark], ['calendar', 'Calendrier', glyphs.IconCalendar], ['star', 'Étoile', glyphs.IconStarFilled],
  ['globe', 'Monde', glyphs.IconGlobe], ['map', 'Carte', glyphs.IconMap], ['chart', 'Graphique', glyphs.IconChart],
  ['code', 'Code', glyphs.IconCode], ['database', 'Base de données', glyphs.IconDatabase], ['board', 'Tableau', glyphs.IconBoard],
  ['paint', 'Design', glyphs.IconPaintBrush], ['palette', 'Nuancier', glyphs.IconFanDeck], ['image', 'Image', glyphs.IconImage],
  ['music', 'Musique', glyphs.IconMusic], ['video', 'Vidéo', glyphs.IconVideo], ['game', 'Jeu', glyphs.IconEmojiGamepad],
  ['bulb', 'Idée', glyphs.IconEmojiLightbulb], ['bolt', 'Éclair', glyphs.IconBolt], ['sparkles', 'Étincelles', glyphs.IconWand],
  ['sprout', 'Pousse', glyphs.IconEmojiSprout], ['rose', 'Rose', glyphs.IconRose], ['heart', 'Cœur', glyphs.IconEmojiHeart],
  ['flag', 'Drapeau', glyphs.IconEmojiFlag], ['ball', 'Sport', glyphs.IconEmojiBall], ['food', 'Cuisine', glyphs.IconEmojiUtensils],
  ['mail', 'Courrier', glyphs.IconMail], ['chat', 'Conversation', glyphs.IconMessage], ['inbox', 'Boîte de réception', glyphs.IconInbox],
  ['link', 'Lien', glyphs.IconLink], ['clip', 'Trombone', glyphs.IconPaperclip], ['pin', 'Épingle', glyphs.IconPinFilled],
  ['lock', 'Cadenas', glyphs.IconLock], ['clock', 'Horloge', glyphs.IconClock], ['alarm', 'Réveil', glyphs.IconAlarm],
  ['package', 'Colis', glyphs.IconPackage], ['ticket', 'Billet', glyphs.IconTicket], ['card', 'Carte bancaire', glyphs.IconCreditCard],
  ['file', 'Document', glyphs.IconFile], ['table', 'Table', glyphs.IconTable], ['gallery', 'Galerie', glyphs.IconGallery],
  ['list', 'Liste', glyphs.IconList], ['check', 'Cocher', glyphs.IconCheck], ['pencil', 'Crayon', glyphs.IconPencil],
  ['phone', 'Téléphone', glyphs.IconPhone], ['brush', 'Rouleau', glyphs.IconPaintRoller], ['dice', 'Dé', glyphs.IconEmojiDice],
  ['sparkle', 'Éclat', glyphs.IconEmojiSparkles], ['cat', 'Chat', glyphs.IconEmojiNavCat], ['burger', 'Burger', glyphs.IconEmojiNavBurger],
  ['car', 'Voiture', glyphs.IconEmojiNavCar], ['smile', 'Sourire', glyphs.IconEmojiSmile], ['hearts', 'Tendresse', glyphs.IconEmojiHearts],
  ['bowl', 'Bol', glyphs.IconEmojiBowl], ['planet', 'Planète', glyphs.IconEmojiGlobe], ['compass', 'Boussole', glyphs.IconEmojiMap],
  ['shine', 'Étoile filante', glyphs.IconEmojiStar], ['currency', 'Monnaie', glyphs.IconCurrency], ['timeline', 'Chronologie', glyphs.IconTimeline],
  ['agenda', 'Agenda', glyphs.IconViewCalendar], ['feed', 'Fil', glyphs.IconViewFeed], ['dashboard', 'Tableau de bord', glyphs.IconViewDashboard],
  ['form', 'Formulaire', glyphs.IconForm], ['templates', 'Modèles', glyphs.IconTemplates], ['folder', 'Dossier', glyphs.IconFolderQuestion],
  ['group', 'Groupe', glyphs.IconGroup], ['filter', 'Filtre', glyphs.IconFilter], ['sort', 'Tri', glyphs.IconSort],
  ['sum', 'Somme', glyphs.IconSigma], ['doc', 'Texte', glyphs.IconFileDoc], ['sheet', 'Tableur', glyphs.IconFileSheet],
  ['slides', 'Présentation', glyphs.IconFileSlides], ['archive', 'Archive', glyphs.IconFileArchive], ['page', 'Page', glyphs.IconPage],
  ['profile', 'Profil', glyphs.IconUserCircle], ['mention', 'Mention', glyphs.IconAt], ['annotation', 'Annotation', glyphs.IconAnnotation],
  ['unlocked', 'Cadenas ouvert', glyphs.IconLockOpen], ['upload', 'Envoi', glyphs.IconUpload], ['download', 'Téléchargement', glyphs.IconDownload],
  ['search', 'Recherche', glyphs.IconSearch], ['bell', 'Cloche', glyphs.IconBell], ['info', 'Information', glyphs.IconInfo],
  ['help', 'Aide', glyphs.IconHelp], ['warning', 'Alerte', glyphs.IconWarning], ['highlighter', 'Surligneur', glyphs.IconHighlighter],
  ['eraser', 'Gomme', glyphs.IconEraser], ['fill', 'Remplissage', glyphs.IconFill], ['hexagon', 'Hexagone', glyphs.IconHexagon],
  ['ellipse', 'Ellipse', glyphs.IconEllipse], ['rectangle', 'Rectangle', glyphs.IconRoundedRectangle], ['spotlight', 'Projecteur', glyphs.IconSpotlight],
  ['play', 'Lecture', glyphs.IconPlayerPlay], ['columns', 'Colonnes', glyphs.IconColumns], ['tabs', 'Onglets', glyphs.IconTabs],
  ['number', 'Numéro', glyphs.IconNumero], ['equation', 'Équation', glyphs.IconEquation], ['hashtag', 'Canal', glyphs.IconHash],
  ['quote', 'Citation', glyphs.IconQuote], ['refresh', 'Cycle', glyphs.IconRefresh], ['cursor', 'Curseur', glyphs.IconCursor],
] as const;

export const teamspaceColors: Record<string, {label:string; css:string}> = {
  gray: {label:shellText("Gris"), css:'currentColor'}, blue:{label:shellText("Bleu"), css:'#448fdb'}, green:{label:shellText("Vert"),css:'#44977e'},
  orange:{label:shellText("Orange"),css:'#d08444'}, red:{label:shellText("Rouge"),css:'#d66660'}, purple:{label:shellText("Violet"),css:'#a07bd0'},
};

export async function teamspaceImage(file: File): Promise<string> {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('Choisissez une image PNG, JPEG ou WebP de 5 Mo maximum.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 96 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    throw new Error('Impossible de lire cette image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
