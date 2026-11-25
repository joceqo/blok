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
] as const;

export const teamspaceColors: Record<string, {label:string; css:string}> = {
  gray: {label:'Gris', css:'currentColor'}, blue:{label:'Bleu', css:'#448fdb'}, green:{label:'Vert',css:'#44977e'},
  orange:{label:'Orange',css:'#d08444'}, red:{label:'Rouge',css:'#d66660'}, purple:{label:'Violet',css:'#a07bd0'},
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
