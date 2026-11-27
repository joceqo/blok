import {shellText} from '../shell-i18n';
import { LOCAL_SERVER_ORIGIN } from '../workspace-registry';
import { button, el, field } from '../ui/dom';

export interface UnreachableOptions {
  frame(): HTMLElement;
  run(action: () => Promise<void>): Promise<void>;
  showError(reason: unknown): void;
  /** Current server origin for the address field. */
  currentOrigin: string;
  /** Retry the gateway boot sequence. */
  onRetry(): void | Promise<void>;
  /** Optional: switch to another server (same validation as login). */
  onServerChange?(origin: string): void | Promise<void>;
}

export function parseServerOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.username
      || url.password
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    ) {
      throw new Error('Utilisez une adresse HTTPS sans identifiants.');
    }
    return url.origin;
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith('Utilisez')) throw reason;
    throw new Error('Saisissez l’adresse complète du serveur, par exemple https://votre-serveur.fr.');
  }
}

/** Dedicated screen when the instance cannot be reached (plan §9.1 `unreachable`). */
export function mountUnreachable(options: UnreachableOptions): void {
  const main = options.frame();
  main.setAttribute('data-cloud-narrow', '');
  const local = options.currentOrigin === LOCAL_SERVER_ORIGIN;
  main.append(el('h1', { text: local ? shellText("Serveur local injoignable") : shellText("Serveur injoignable") }));
  if (local) {
    main.append(el('p', { children: ['Démarrez Docker, puis lancez ', el('code', { text: './deploy/local.sh start' }), ' depuis le dépôt Blok. Pour la première installation, utilisez ', el('code', { text: './deploy/local.sh install' }), '.'] }));
  } else {
    main.append(el('p', { text: options.currentOrigin
      ? shellText("Vérifiez votre connexion à {v0}, puis réessayez.", {v0: options.currentOrigin})
      : shellText("Vérifiez votre connexion au serveur, puis réessayez."), attribute: 'data-cloud-muted' }));
  }
  main.append(button({
    label: shellText("Réessayer"),
    primary: true,
    onClick: () => { void options.run(async () => { await options.onRetry(); }); },
  }));

  const onServerChange = options.onServerChange;
  if (!onServerChange) return;
  const details = el('details', { attribute: 'data-cloud-section' });
  details.append(el('summary', { text: shellText("Se connecter à un autre serveur") }));
  const form = el('form', { attribute: 'data-cloud-stack' });
  const server = field({
    form,
    label: shellText("Adresse du serveur"),
    type: 'url',
    name: 'server',
    value: options.currentOrigin,
  });
  server.placeholder = 'https://votre-serveur.fr';
  server.setAttribute('autocomplete', 'url');
  server.spellcheck = false;
  const submit = button({ label: shellText("Utiliser ce serveur"), primary: true, block: true, type: 'submit', onClick: () => {} });
  form.append(submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void options.run(async () => {
      await onServerChange(parseServerOrigin(server.value.trim()));
    });
  });
  details.append(
    el('p', { text: shellText("Chaque serveur conserve ses propres comptes et espaces."), attribute: 'data-cloud-note' }),
    form,
  );
  main.append(details);
}
