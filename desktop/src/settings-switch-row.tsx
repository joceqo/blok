import {useId} from 'react';

export function SettingsSwitchRow({label, help, checked, disabled, onChange}: {
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  const id = useId();
  return <div className="settings-panel-row">
    <div className="settings-panel-label">
      <strong id={id}>{label}</strong>
      <small id={id + '-help'}>{help}</small>
    </div>
    <button type="button" className="settings-panel-switch" role="switch"
      aria-labelledby={id} aria-describedby={id + '-help'} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}/>
  </div>;
}
