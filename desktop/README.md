# Blok desktop

Tauri 2 hosts the shared sidebar and a real Blok editor. Its 40 px title bar follows
`notion-lab-desktop/apps/clean-client-2/src/shell/window-tabs.css`: the sidebar
controls occupy the sidebar width, followed by navigation, tabs, and an adjacent
new-tab button. The macOS window uses an overlay title bar with traffic lights at
16, 21 and starts at 1440×900.

## TSX component style

See the [desktop TSX style guide](./STYLEGUIDE.md) for component conventions and sidebar formatting commands.

For web builds, set `VITE_BLOK_DESKTOP_DOWNLOAD_URL` to the published installer or download page to enable the desktop download card in the sidebar. The web Docker build accepts the same build argument.

## Standalone app with the embedded Node server

The Apple Silicon build runs on macOS 15 or newer. Open Blok to start in your local account and workspace. Your operating-system profile owns this account. Email authentication applies when you choose to connect to a remote Blok server. The app starts its own Node backend, PostgreSQL and SeaweedFS on loopback. It works offline, including the editor and attachments. External AI providers require an internet connection.

Quitting Blok stops its services. Accounts, documents and attachments persist in `~/Library/Application Support/dev.notiooon.blok/embedded-server`. At upgrade, Blok imports the original default disk workspace, including page bodies, hierarchy, trash and database-row pages. It archives the original JSON files byte-for-byte in PostgreSQL and keeps the source folder on disk. The import runs once. Other disk workspaces remain accessible from the switcher.

To build on an Apple Silicon Mac with the Tauri prerequisites and repository dependencies installed, run the following from the repository root. The first build downloads the pinned runtime binaries. End users only need the packaged app.

```sh
npm ci --prefix apps/service-node
npm ci --prefix packages/server/node
npm ci --prefix desktop
npm run build:embedded --prefix desktop
```

## Calendar

Open **Calendrier** in the workspace sidebar. Select a day in the mini-calendar, toggle sources to overlay their events, and select an appointment to open its details or a linked Blok page. Drag a timed workspace event in the grid to move it, or drag its lower edge to change its duration. The event form provides the same edits using a keyboard.

The shared workspace calendar runs offline in the embedded app. On a Node workspace, members can subscribe to a Google, Outlook or iCloud calendar URL via **Abonnements**. Each subscription belongs to the signed-in member. Subscriptions are refreshed when opening or refocusing the calendar, every five minutes while visible, or via **Actualiser**. Files imported via **Importer .ics** become workspace events after confirmation.

Each member can also connect a Google account, select individual Google calendars, and share busy periods from their primary Google calendar with their workspace. This works both on a configured self-hosted server and in the embedded app, which derives its own loopback callback and reads its Google client from `google-calendar.json` in its data directory. Details of external events are read-only. See the Google Calendar OAuth section in `../deploy/README.md` for both setups.

## Local data in disk workspaces

On this Mac, pages are saved under:

`/Users/joce/Library/Application Support/dev.notiooon.blok/workspace`

`index.json` holds page titles, hierarchy, cover presets and the current page. Each page body is
saved as `<page-id>.json` in the same folder. Tauri resolves this location from
`app_data_dir`, so another macOS account or operating system uses its own data
directory. Saves use a temporary file and rename on macOS.
The sidebar footer opens an **Espace local** menu. **Profil local** changes the
display name on this device; it is not an online account. **Préférences** offers
a saved light, dark or system appearance; **Données locales** displays the path
and the Blok and app versions. The footer menu can copy the path directly.
Each page can have a bundled gradient or image cover. The choice and vertical
position are saved in `index.json`; adding, changing or removing a cover does
not change the editor body. The image presets come from the reference desktop
project's NASA/Webb cover assets.

## AI assistant

The Blok button opens the shared assistant panel with conversation history, page context and a provider/model picker. In **Paramètres → Assistant IA**, configure OpenAI with a personal key or (as workspace administrator) a shared key. Personal credentials take priority and never silently fall back after an API error. Keys are masked and never stored in browser localStorage. The selected model and key source appear in the assistant.

In a workspace backed by the Node service with pgvector, an administrator can open **Paramètres → Assistant IA → OpenAI pour le workspace → Activer l’indexation**. A shared OpenAI key is required. This sends page titles and text, including private pages, to OpenAI's `text-embedding-3-small` model. Switching the chat provider to Codex does not change the embedding model. In the chat, enable workspace search to query the index. The palette stays lexical. The standalone embedded build includes pgvector. For Docker, set `BLOK_POSTGRES_IMAGE=pgvector/pgvector:0.8.7-pg17` for a new installation or install the extension compatible with your existing database image.

**Paramètres → Assistant IA → Statistiques** shows completed calls and provider-reported tokens over 7 or 30 UTC days. The feature and provider breakdowns cover new activity recorded after the upgrade. Each member sees their own calls in the workspace. Administrators also see background indexing. The Node service keeps daily counters in PostgreSQL. Native Codex, Claude Code and disk-workspace OpenAI calls are counted on the device. The counters contain no prompts or page content. The overview includes input, cached input (a subset of input), output and aggregate tokens by model and feature. The estimated USD amount uses supported standard API rates and shows how many calls could be priced. CLI activity uses terminal-reported usage when available. Administrators can see processed pages and passages in the current search index.

The Node service logs JSON events `embedding.index`, `embedding.query` and `search.hybrid` with duration, token usage when returned, and result counts. In the packaged macOS app these events are in `~/Library/Application Support/dev.notiooon.blok/embedded-server/runtime.log`. No query or page text is included in these events.

For remote workspaces, requests use the authenticated workspace service and encrypted credentials in PostgreSQL. Local native workspaces use a separate credential in the operating system keychain and the Rust HTTPS client. Codex and Claude Code remain available in the native app via their existing CLI authentication. The browser cannot inspect or execute tools installed on the Mac.

## Sharing

Remote workspaces support email login, membership roles, join requests, invitations and durable real-time collaboration. Local workspaces remain separate and stored on this machine. See `../deploy/README.md` for the Docker stack, demo accounts, data volumes and backup/restore workflow. Switching workspaces waits for pending document writes before loading the new context.

The tab strip separately keeps its per-tab history in the webview's
`sessionStorage` under `blok:window-tabs:v1`; this is window state, not the page
storage. When running only the Vite preview in a browser, pages use that
browser's `localStorage` instead of native files.

Web and Tauri use the React sidebar in `desktop/src/sidebar/`. Build with `VITE_SIDEBAR_TSX=0` to compare the original frame from `src/shell/sidebar.ts`. The editor code comes from
`src/full.ts`. Install the repository dependencies before building the desktop
package; Vite resolves those sources and their dependencies from the repository.
The desktop currently bundles the repository's Blok 2.1.0 source; its own Tauri
app version is 0.1.0. `defaultTools` contains only paragraphs, headings and
lists, so the desktop also registers Table, Database, DatabaseRow and
DatabaseComment explicitly for the slash menu and saved documents.
`src/editor.css` explicitly includes the root `src/` in Tailwind's source scan;
without it, editor controls and popovers lose their utility styles in desktop.
React Grab is available in the packaged Tauri app and in development. Press
⌘/Ctrl + Shift + G or choose “Sélectionner un élément” in Settings to copy
context about an element. Web production builds opt in with `VITE_REACT_GRAB=true`.

The app icon uses the Blok mascot from `docs/public/logo-no-sign.png`. Regenerate the source with `swift scripts/generate-icon.swift ../docs/public/logo-no-sign.png src-tauri/icons/icon-source.png`, then run `npx tauri icon src-tauri/icons/icon-source.png` to refresh the platform icons.

```bash
npm ci
cd desktop
npm ci
npm test
npm run tauri dev
npx tauri build --bundles app
```


## Local Docker sync smoke test

From the repository root, start the seeded demo with `./deploy/demo.sh start`. With the root Yarn dependencies and Playwright Chromium or Google Chrome installed, run the following command.

```sh
node desktop/src/cloud/demo-sync-smoke.mjs
```

This opt-in browser check signs in as `membre@example.test` using the local HTTP mailbox and creates one uniquely named page in the seeded `equipe` workspace. It edits two blocks in separate browser contexts, disconnects one client, checks convergence after reconnect and reload, then waits for the stored page read from Node. The page stays in the demo so its printed URL can be opened again.

The script reads `DEMO_WEB_PORT` and `DEMO_MAIL_PORT` (defaults `8088` and `8089`). Both connections use localhost. Run one check at a time with the demo account. The check waits through one 45-second login-code cooldown. Repeated requests can reach the service’s hourly login limit. After both clients leave, the collaboration room normally takes another 30 seconds to flush the final snapshot.

## Native shell with a local or remote server

Tauri bundles the same TypeScript shell and editor used by the browser. On a fresh installation, the standalone package opens your device workspace. The smaller package opens a disk workspace. In the connection screen, choose **Se connecter à un autre serveur** and enter the Docker demo URL or an HTTPS server. The native adapter stores remote sessions in the OS keychain.

To preselect a server when building the native app, set `VITE_BLOK_SERVER_URL` for the build. An explicitly chosen server or an already active remote workspace takes precedence.

```sh
cd desktop
VITE_BLOK_SERVER_URL=http://localhost:8088 npm run tauri -- build --bundles app
```

## Sauvegarde d’un espace personnel du DMG

Dans le menu de l’espace du compte appareil, ouvrir **Sauvegarde de l’espace**.
Choisir **Sauvegarder cet espace** ou **Restaurer dans un nouvel espace**. Une
restauration crée une copie indépendante dans le sélecteur. L’export comprend
les pages et leurs corps, la corbeille, les espaces d’équipe, les événements
locaux, les emojis et les fichiers. Les comptes externes doivent être reconnectés.

- **Dossier, disque externe ou NAS** ouvre le sélecteur natif sur macOS. Pour
  restaurer, sélectionner le dossier daté qui contient `workspace.json`.
- **Git** accepte un dépôt HTTPS vide ou une sauvegarde du même espace. La
  branche `blok-backup` contient les instantanés. Git et Git LFS sont fournis
  dans le DMG. Les vidéos et les médias de 32 Mio ou plus passent par LFS.
  Utiliser un dépôt privé et des identifiants avec accès en écriture, puis en
  lecture pour la restauration. Les quotas sont ceux du compte chez l’hébergeur.
- **S3 compatible** utilise un bucket existant. Indiquer le point de terminaison,
  la région, les identifiants et un préfixe propre à l’espace. Pour restaurer la
  copie la plus récente, saisir le même préfixe. Pour choisir une génération
  précise, reprendre le chemin affiché à la fin de la sauvegarde.

Le transfert démarre à la demande. La dernière version publiée reste accessible
si un nouvel envoi échoue. Le formulaire garde les identifiants saisis en mémoire
pendant son utilisation. Les pièces jointes sont restaurées avec de nouvelles
clés sur le Mac de destination. L’import de fichiers depuis l’app embarquée accepte
jusqu’à 1 Gio par fichier. L’import par URL conserve sa limite propre.
