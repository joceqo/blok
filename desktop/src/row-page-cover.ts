import type { DatabaseRowPages } from '../../types/tools/database';
import { isPageCover } from './cover';
import type { DesktopPage } from './storage';

export interface RowPageCoverOptions {
  /** The page record in the workspace manifest, which the write changes in place. */
  page(pageId: string): DesktopPage | undefined;
  readOnly(pageId: string): boolean;
  save(): void;
  /** Redraw that page when it is the one on screen. */
  refresh(pageId: string): void;
}

/**
 * A row that owns a page keeps its cover with that page, next to its title and
 * icon, exactly where the page shell reads it. Keeping it in the row block
 * instead is what made the same button show a cover in the peek and none on
 * the page it opens.
 */
export function createRowPageCoverChannel(options: RowPageCoverOptions): NonNullable<DatabaseRowPages['cover']> {
  return {
    read(pageId) {
      const page = options.page(pageId);

      if (page === undefined || !isPageCover(page.cover)) return undefined;

      return {
        cover: page.cover,
        ...(typeof page.coverPosition === 'number' ? { position: page.coverPosition } : {}),
      };
    },
    write(pageId, patch) {
      const page = options.page(pageId);

      // A row body is deliberately absent from the sidebar index (service
      // documents.go), so there is no page record to write on. Saying so lets
      // the database keep the cover on the row block instead of losing it.
      if (page === undefined || options.readOnly(pageId)) return false;
      if (patch.cover !== undefined) {
        // A new image is framed from its own centre, as the page shell's own picker does.
        if (patch.cover === null) delete page.cover;
        else page.cover = patch.cover;
        delete page.coverPosition;
      }
      if (patch.position !== undefined) page.coverPosition = patch.position;
      options.save();
      options.refresh(pageId);

      return true;
    },
  };
}
