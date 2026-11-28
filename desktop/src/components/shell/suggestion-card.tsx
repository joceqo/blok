import {shellText} from '../../shell-i18n';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { Tooltip } from './tooltip';
import './suggestion-card.css';

export const DismissButton = ({ label, onDismiss }: { label: string; onDismiss(): void }) => (
  <Tooltip label={label}>
    <Button
      type="button"
      className="shell-dismiss-button"
      variant="plain"
      aria-label={label}
      onClick={onDismiss}
    >
      <X
        size={14}
        aria-hidden="true"
      />
    </Button>
  </Tooltip>
);

interface SuggestionCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  onSelect(): void;
  onDismiss(): void;
}

export const SuggestionCard = ({
  title,
  description,
  icon,
  onSelect,
  onDismiss,
}: SuggestionCardProps) => (
  <div className="shell-suggestion-card">
    <Button
      type="button"
      className="shell-suggestion-action"
      variant="plain"
      onClick={onSelect}
    >
      <span
        className="shell-suggestion-icon"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </Button>
    <DismissButton
      label={shellText("Masquer « {v0} »", {v0: title})}
      onDismiss={onDismiss}
    />
  </div>
);
