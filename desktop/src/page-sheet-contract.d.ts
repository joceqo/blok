import type {I18n} from '../../types';
export interface HostPageSheetOptions {
  pageId: string;
  title: string;
  i18n?: I18n;
  onClose(): void;
  onOpenFullPage(): void;
  onPrevious?(): void;
  onNext?(): void;
}
export function mountHostPageSheet(wrapper: HTMLElement, editorSlot: HTMLElement, options: HostPageSheetOptions): {
  setNeighbors(previous: boolean, next: boolean): void;
  destroy(): void;
};
