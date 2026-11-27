import './switch-row.css';
import { useId } from 'react';

export const SwitchRow = ({
  settingId,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  settingId?: string;
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) => {
  const id = useId();
  return (
    <div className="settings-panel-row" data-setting={settingId}>
      <div className="settings-panel-label">
        <strong id={id}>{label}</strong>
        <small id={`${id}-help`}>{help}</small>
      </div>
      <button
        type="button"
        className="settings-panel-switch"
        role="switch"
        aria-labelledby={id}
        aria-describedby={`${id}-help`}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
};
