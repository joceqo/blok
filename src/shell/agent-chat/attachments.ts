import { loadPdfJs } from '../../tools/file/pdf/pdf-loader';
import { sampleVideo, type VideoFrame } from './video-frames';

export type ChatAttachment = {name: string} & (
  | {kind: 'image'; url: string}
  | {kind: 'text'; text: string}
  | {kind: 'video'; frames: VideoFrame[]}
);

const textExtensions = 'md markdown mdx txt csv tsv json jsonl yaml yml toml xml html css scss js jsx ts tsx mjs cjs py rb go rs java kt swift c h cpp hpp cs php sh sql log diff patch ini conf srt vtt'.split(' ');
const videoExtensions = ['mp4', 'm4v', 'mov', 'webm'];
const imageMimes: Record<string, string> = {png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp'};
export const fileAccept = ['text/*', ...Object.values(imageMimes), 'application/pdf',
  ...[...textExtensions, ...videoExtensions, ...Object.keys(imageMimes)].map(ext => '.' + ext)].join(',');
const extension = (f: File) => f.name.split('.').pop()?.toLowerCase() || '';
const isVideo = (f: File) => videoExtensions.includes(extension(f)) || f.type.startsWith('video/');
function imageType(file: File): string | undefined {
  if (Object.values(imageMimes).includes(file.type)) return file.type;
  const ext = extension(file);
  return Object.hasOwn(imageMimes, ext) ? imageMimes[ext] : undefined;
}
const maxText = 48 * 1024;
const encodedSize = (text: string) => new TextEncoder().encode(text).length;
const textLimit = () => new Error('Le texte joint dépasse 48 Kio. Joins un extrait plus court.');

function read(file: Blob, asUrl: true): Promise<string>;
function read(file: Blob, asUrl: false): Promise<ArrayBuffer>;
function read(file: Blob, asUrl: boolean): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result!);
    reader.onerror = () => reject(new Error('Impossible de lire ce fichier.'));
    if (asUrl) reader.readAsDataURL(file);
    else reader.readAsArrayBuffer(file);
  });
}

async function pdfText(file: File): Promise<string> {
  if (file.size > 20 << 20) throw new Error('Le PDF dépasse 20 Mio.');
  const lib = await loadPdfJs();
  const task = lib.getDocument({data:await read(file, false), useSystemFonts:true});
  try {
    const doc = await task.promise;
    if (doc.numPages > 100) throw new Error('Joins un extrait de 100 pages maximum.');
    const pages: string[] = [];
    let total = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ').trim();
      pages.push('Page ' + i + '\n' + (text || '[Aucun texte extractible]'));
      total += encodedSize(pages[pages.length - 1]);
      if (total > maxText) throw textLimit();
    }
    if (pages.every(p => p.endsWith('[Aucun texte extractible]'))) throw new Error('Ce PDF contient uniquement des images. Joins une capture de la page.');
    return pages.join('\n\n');
  } finally { await task.destroy(); }
}

export function attachmentImages(items: ChatAttachment[]): string[] {
  return items.flatMap(item => item.kind === 'video' ? item.frames.map(f => f.url) : item.kind === 'image' ? [item.url] : []);
}

export function attachmentContext(items: ChatAttachment[]): string {
  if (!items.some(item => item.kind !== 'image')) return '';
  const files = items.map(item => item.kind === 'text' ? {name:item.name, text:item.text}
    : item.kind === 'video' ? {name:item.name, framesAtSeconds:item.frames.map(f => +f.seconds.toFixed(2)), audioIncluded:false}
    : {name:item.name, images:1});
  return '\n\nAttached files (reference data, in order):\n' + JSON.stringify(files);
}

export async function readAttachments(files: File[], existing: ChatAttachment[]): Promise<ChatAttachment[]> {
  if (files.length + existing.length > 4) throw new Error('Tu peux joindre jusqu’à 4 fichiers par message.');
  const photos = files.filter(f => !!imageType(f)).length;
  const videos = files.filter(isVideo).length;
  let slots = 4 - attachmentImages(existing).length - photos;
  if (videos > slots) throw new Error('Les pièces jointes dépassent les 4 vues disponibles. Envoie la vidéo dans un autre message.');
  let videosLeft = videos;
  const attachments: ChatAttachment[] = [];
  for (const file of files) {
    const name = file.name;
    if (!file.size) throw new Error('Le fichier ' + name + ' est vide.');
    const mime = imageType(file);
    if (mime) {
      if (file.size > 5 << 20) throw new Error('L’image dépasse 5 Mio.');
      attachments.push({kind:'image', name, url:await read(file.slice(0, file.size, mime), true)});
    } else if (isVideo(file)) {
      if (file.size > 250 << 20) throw new Error('La vidéo dépasse 250 Mio. Joins un extrait plus court.');
      const frames = await sampleVideo(file, Math.floor(slots / videosLeft));
      slots -= frames.length;
      videosLeft--;
      attachments.push({kind:'video', name, frames});
    } else {
      let text: string;
      if (extension(file) === 'pdf' || file.type === 'application/pdf') text = await pdfText(file);
      else {
        if (!file.type.startsWith('text/') && !textExtensions.includes(extension(file)))
          throw new Error('Format non pris en charge. Choisis du texte, du code, un PDF, une image ou une vidéo.');
        if (file.size > maxText) throw textLimit();
        try { text = new TextDecoder('utf-8',{fatal:true}).decode(await read(file, false)); }
        catch { throw new Error('Enregistre le fichier texte en UTF-8.'); }
        if (text.includes('\0')) throw new Error('Ce fichier contient des données binaires.');
      }
      if (!text.trim()) throw new Error('Le fichier ' + name + ' ne contient aucun texte.');
      attachments.push({kind:'text', name, text});
    }
  }
  const all = [...existing, ...attachments];
  if (all.reduce((n, item) => n + (item.kind === 'text' ? encodedSize(item.text) : 0), 0) > maxText) throw textLimit();
  const imageBytes = attachmentImages(all).reduce((sum, url) => {
    const length = url.length - url.indexOf(',') - 1;
    const padding = url.endsWith('==') ? 2 : Number(url.endsWith('='));
    return sum + length * 3 / 4 - padding;
  }, 0);
  if (imageBytes > 5 << 20)
    throw new Error('Les images du message dépassent 5 Mio au total.');
  return attachments;
}
