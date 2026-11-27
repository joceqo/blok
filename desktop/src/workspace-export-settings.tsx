import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SwitchRow,
} from './components';
import { shellText } from './shell-i18n';
import { type ExportOptions, type ExportWorkspace } from './workspace-export';

const ExportChoice = <T extends string>({
  label,
  value,
  choices,
  onChange,
  container,
}: {
  label: string;
  value: T;
  choices: [T, string][];
  onChange(value: T): void;
  container: HTMLDialogElement | null;
}) => (
  <div className="workspace-export-row">
    <span>{label}</span>
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" />}
        aria-label={label}
      >
        {choices.find(([id]) => id === value)?.[1]} <ChevronDown size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={container}
        align="end"
      >
        {choices.map(([id, text]) => (
          <DropdownMenuItem
            key={id}
            onClick={() => onChange(id)}
          >
            {text} {id === value && <Check size={14} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

export const WorkspaceExportSettings = ({
  workspace,
  run,
}: {
  workspace: string;
  run: ExportWorkspace;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const job = useRef<AbortController | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [options, setOptions] = useState<ExportOptions>({
    format: 'md',
    views: 'current',
    attachments: true,
    privatePages: false,
    folders: true,
  });
  useEffect(() => () => job.current?.abort(), []);
  function change<K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) {
    setOptions((current) => ({ ...current, [key]: value }));
  }
  async function download() {
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setBusy(true);
    setError('');
    try {
      const archive = await run(options, controller.signal);
      controller.signal.throwIfAborted();
      const { fileStem } = await import('./workspace-export');
      controller.signal.throwIfAborted();
      if ('__TAURI_INTERNALS__' in window) {
        const { invoke } = await import('@tauri-apps/api/core');
        const bytes = await archive.arrayBuffer();
        controller.signal.throwIfAborted();
        const path = await invoke<string>('save_workspace_export', bytes, {
          headers: { 'x-blok-workspace': encodeURIComponent(fileStem(workspace)) },
        });
        setStatus(shellText('Archive enregistrée dans {v0}', { v0: path }));
        dialog.current?.close();
        return;
      }
      const url = URL.createObjectURL(archive);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileStem(workspace) + '.zip';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus(shellText('Téléchargement de l’archive lancé.'));
      dialog.current?.close();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : shellText('Export impossible.'));
    } finally {
      if (job.current === controller) {
        job.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <div
        className="settings-panel-row"
        data-setting="workspace-export"
      >
        <div className="settings-panel-label">
          <strong>{shellText('Contenu de l’espace de travail')}</strong>
          <small>
            {shellText('Exporter les pages de {v0} dans une archive ZIP.', { v0: workspace })}
          </small>
        </div>
        <Button
          onClick={() => {
            setError('');
            setStatus('');
            setOpened(true);
            dialog.current?.showModal();
          }}
        >
          {shellText('Exporter')}
        </Button>
      </div>
      {status && <p role="status">{status}</p>}
      <dialog
        ref={dialog}
        className="workspace-export-dialog"
        aria-label={shellText('Exporter l’espace de travail')}
        onClose={() => {
          job.current?.abort();
          setOpened(false);
        }}
      >
        {opened && (
          <>
            <h3>{shellText('Exporter l’espace de travail')}</h3>
            <fieldset disabled={busy}>
              <ExportChoice
                label={shellText('Format')}
                value={options.format}
                container={dialog.current}
                choices={[
                  ['md', shellText('Markdown et CSV')],
                  ['html', shellText('HTML et CSV')],
                ]}
                onChange={(v) => change('format', v)}
              />
              <ExportChoice
                label={shellText('Vues de base de données')}
                value={options.views}
                container={dialog.current}
                choices={[
                  ['current', shellText('Vue actuelle')],
                  ['all', shellText('Toutes les vues')],
                ]}
                onChange={(v) => change('views', v)}
              />
              <ExportChoice
                label={shellText('Contenu de la page')}
                value={options.attachments ? 'all' : 'text'}
                container={dialog.current}
                choices={[
                  ['all', shellText('Tout')],
                  ['text', shellText('Sans pièces jointes')],
                ]}
                onChange={(v) => change('attachments', v === 'all')}
              />
              <SwitchRow
                help=""
                label={shellText('Inclure les pages privées')}
                checked={options.privatePages}
                onChange={(v) => change('privatePages', v)}
              />
              <SwitchRow
                help=""
                label={shellText('Créer des dossiers pour les sous-pages')}
                checked={options.folders}
                onChange={(v) => change('folders', v)}
              />
            </fieldset>
            {error && <p role="alert">{error}</p>}
            <footer>
              <Button
                variant="ghost"
                onClick={() => dialog.current?.close()}
              >
                {shellText('Annuler')}
              </Button>
              <Button
                className="workspace-export-primary"
                disabled={busy}
                onClick={download}
              >
                {busy ? shellText('Exportation…') : shellText('Exporter')}
              </Button>
            </footer>
          </>
        )}
      </dialog>
    </>
  );
};
