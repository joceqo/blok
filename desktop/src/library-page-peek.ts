import {mountHostPageSheet, type HostPageSheetOptions} from '@blok/page-sheet';
import {shellI18n} from './shell-i18n';

export function mountLibraryPageSheet(wrapper: HTMLElement, editorSlot: HTMLElement, options: HostPageSheetOptions) {
  return mountHostPageSheet(wrapper, editorSlot, {...options, i18n: options.i18n ?? shellI18n});
}
