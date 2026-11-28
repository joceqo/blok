import { CloudClient } from '../../desktop/src/cloud/client';
import '../../desktop/src/shell.css';

export type ShellTheme = 'light' | 'dark';

/** Scope the desktop palette to this preview, including when several stories share a page. */
export function shellPreview(theme: ShellTheme): HTMLDivElement {
  const host = document.createElement('div');
  host.lang = 'fr';
  host.setAttribute('data-desktop-shell', '');
  host.setAttribute('data-blok-theme', theme);
  host.style.minHeight = '100vh';
  return host;
}

/** A transport owned by one render. It never falls through to the network. */
export class PreviewClient extends CloudClient {
  constructor(private readonly reply: (path: string, init?: RequestInit) => unknown) {
    super({ origin: 'https://blok.example.test' });
  }

  override async request<T>(path: string, init?: RequestInit): Promise<T> {
    return this.reply(path, init) as T;
  }
}
