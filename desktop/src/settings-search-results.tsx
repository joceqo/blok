import {ChevronRight} from 'lucide-react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Button} from './components';
import type {ResultGroup, Setting, SettingsPanel} from './settings-search';
import './settings-search.css';

type SelectSetting = (panel: SettingsPanel, setting: Setting) => void;

const SettingsSearchResults = ({groups, onSelect}: {groups: ResultGroup[]; onSelect: SelectSetting}) => (
  <>
    {groups.map(({panel, group, title, results}) => (
      <section className="settings-search-group" key={panel} aria-label={group + ' / ' + title}>
        <h3>{group} <ChevronRight size={12} aria-hidden="true" /> {title}</h3>
        {results.map(item => (
          <Button key={item.selector} variant="plain" className="settings-search-hit"
            onClick={() => onSelect(panel, item)}>
            <strong>{item.label}</strong>
            <small>{item.description}</small>
          </Button>
        ))}
      </section>
    ))}
  </>
);

export function mountSettingsSearchResults(host: HTMLElement, onSelect: SelectSetting) {
  const root = createRoot(host);
  return {
    render: (groups: ResultGroup[]) => flushSync(() => root.render(<SettingsSearchResults groups={groups} onSelect={onSelect} />)),
    destroy: () => root.unmount(),
  };
}
