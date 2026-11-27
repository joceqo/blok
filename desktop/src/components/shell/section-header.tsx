import { ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from './button';
import { Tooltip } from './tooltip';
import './section-header.css';

interface SectionHeaderProps extends Omit<ComponentProps<'div'>, 'onToggle'> {
  label: string;
  expanded: boolean;
  onToggle(): void;
  children?: ReactNode;
}
export const SectionHeader = ({
  label,
  expanded,
  onToggle,
  children,
  className,
  ...props
}: SectionHeaderProps) => (
  <div
    {...props}
    className={['shell-section-header', className].filter(Boolean).join(' ')}
  >
    <Button
      type="button"
      variant="plain"
      className="shell-section-toggle"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {label}
      <ChevronRight
        aria-hidden="true"
        size={12}
      />
    </Button>
    <div className="shell-section-actions">{children}</div>
  </div>
);

interface SectionActionProps
  extends Omit<ComponentProps<typeof Button>, 'aria-label' | 'title' | 'variant'> {
  label: string;
  tooltip?: string;
}
export const SectionAction = ({
  label,
  tooltip = label,
  children,
  ...props
}: SectionActionProps) => (
  <Tooltip label={tooltip}>
    <Button
      {...props}
      variant="plain"
      type="button"
      aria-label={label}
    >
      {children}
    </Button>
  </Tooltip>
);
