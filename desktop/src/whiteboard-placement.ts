import {shellText} from './shell-i18n';
import { IconBoard } from '../../src/components/icons';
import type { BlockAPI, MenuConfig } from '../../types';

class WhiteboardPlacement {
  static readonly isTune = true;
  readonly save?: () => boolean;
  private readonly block: BlockAPI;

  constructor({ block, data }: { block: BlockAPI; data: unknown }) {
    this.block = block;
    // Preserve placement flags written by the original paragraph-board prototype.
    if (typeof data === 'boolean') this.save = () => data;
  }

  render(): MenuConfig {
    return {
      name: 'whiteboard-placement',
      icon: IconBoard,
      title: shellText("Ouvrir dans le tableau blanc"),
      onActivate: () => this.block.holder.dispatchEvent(new CustomEvent('blok:whiteboard-place', { bubbles: true })),
      closeOnActivate: true,
    };
  }
}

export { WhiteboardPlacement as whiteboardPlacementTune };
