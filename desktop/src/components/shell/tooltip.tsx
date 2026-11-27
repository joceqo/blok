import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { useRef, type ReactElement } from 'react';
import './tooltip.css';

export interface TooltipProps {
  label: string;
  shortcut?: string;
  side?: BaseTooltip.Positioner.Props['side'];
  sideOffset?: number;
  children: ReactElement;
}

export const Tooltip = ({
  label,
  shortcut,
  side = 'bottom',
  sideOffset = 6,
  children,
}: TooltipProps) => {
  const host = useRef<HTMLElement | null>(null);
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger
        render={children}
        ref={(node: HTMLElement | null) => {
          host.current =
            node?.closest<HTMLElement>('[data-blok-shell],[data-desktop-shell]') ?? null;
        }}
      />
      <BaseTooltip.Portal container={host}>
        <BaseTooltip.Positioner
          className="shell-tooltip-positioner"
          side={side}
          sideOffset={sideOffset}
          collisionPadding={6}
        >
          <BaseTooltip.Popup
            className="shell-tooltip"
            role="tooltip"
          >
            {label}
            {shortcut && <kbd>{shortcut}</kbd>}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
};
