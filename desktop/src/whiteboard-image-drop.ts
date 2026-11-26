import type { Uploader } from '../../types';
import { readCoverFile } from './cover';
import type { BoardElement } from './whiteboard-element';

interface DropOptions {
  viewport: HTMLElement;
  world: HTMLElement;
  zoom(): number;
  writable(): boolean;
  uploader(): Uploader | undefined;
  assetOrigin?: string;
  place(item: BoardElement): void;
  status(text: string): void;
}

async function dimensions(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {width:image.naturalWidth, height:image.naturalHeight};
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function bindBoardImageDrop(options: DropOptions) {
  const { viewport, world } = options;
  const listeners = new AbortController();
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
  const writable = () => !listeners.signal.aborted && options.writable();

  function over(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer!.dropEffect = writable() ? 'copy' : 'none';
  }

  async function drop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!writable()) return;
    const files = Array.from(event.dataTransfer!.files);
    const origin = world.getBoundingClientRect();
    const zoom = options.zoom();
    const x = (event.clientX - origin.left) / zoom;
    const y = (event.clientY - origin.top) / zoom;
    const errors: string[] = [];
    let placed = 0;
    for (const file of files) {
      if (!writable()) return;
      try {
        if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) {
          throw new Error('Choisissez une image PNG, JPEG, GIF ou WebP.');
        }
        options.status('Ajout de ' + file.name + '…');
        const { width, height } = await dimensions(file);
        if (!writable()) return;
        const uploader = options.uploader();
        let url: string;
        if (uploader?.isConfigured('image')) {
          const result = await uploader.uploadByFile(file, {kind:'image', tool:'whiteboardElement'});
          const asset = new URL(result.url, options.assetOrigin ?? location.href);
          if (asset.origin !== (options.assetOrigin ?? location.origin) || !asset.pathname.startsWith('/files/')) {
            throw new Error('Adresse de stockage de l’image invalide.');
          }
          url = asset.pathname;
        } else {
          url = await readCoverFile(file);
        }
        if (!writable()) return;
        const scale = Math.min(1, 480 / width, 360 / height);
        const offset = 24 * placed / zoom;
        options.place({kind:'image', x:x + offset, y:y + offset, w:width * scale, h:height * scale, text:file.name, url});
        placed++;
      } catch (error) {
        errors.push(file.name + ' — ' + (error instanceof Error ? error.message : 'Import impossible.'));
      }
    }
    if (!listeners.signal.aborted) options.status(errors.join('\n'));
  }

  viewport.addEventListener('dragover', over, {capture:true, signal:listeners.signal});
  viewport.addEventListener('drop', drop, {capture:true, signal:listeners.signal});
  return () => listeners.abort();
}
