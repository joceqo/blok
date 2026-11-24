# Blok desktop

Tauri 2 hosts the shared sidebar and a real Blok editor. Its 40 px title bar follows
`notion-lab-desktop/apps/clean-client-2/src/shell/window-tabs.css`: the sidebar
controls occupy the sidebar width, followed by navigation, tabs, and an adjacent
new-tab button. The macOS window uses an overlay title bar with traffic lights at
16, 21 and starts at 1440×900.

## Standalone app with the embedded Node server

The Apple Silicon build runs on macOS 15 or newer. Open Blok and create a workspace with your name, email and password. The app starts its own Node backend, PostgreSQL and SeaweedFS on loopback. It works offline, including the editor and attachments. External AI providers require an internet connection.

Quitting Blok stops its services. Accounts, documents and attachments persist in `~/Library/Application Support/dev.notiooon.blok/embedded-server`. An existing disk workspace keeps opening as before. Use **Paramètres → Connexions → Ouvrir le serveur intégré** to set up the server alongside it.

To build on an Apple Silicon Mac with the Tauri prerequisites and repository dependencies installed, run the following from the repository root. The first build downloads the pinned runtime binaries. End users only need the packaged app.

```sh
npm ci --prefix apps/service-node
npm ci --prefix packages/server/node
npm ci --prefix desktop
npm run build:embedded --prefix desktop
```

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

For remote workspaces, requests use the authenticated workspace service and encrypted credentials in PostgreSQL. Local native workspaces use a separate credential in the operating system keychain and the Rust HTTPS client. Codex and Claude Code remain available in the native app via their existing CLI authentication. The browser cannot inspect or execute tools installed on the Mac.

## Sharing

Remote workspaces support email login, membership roles, join requests, invitations and durable real-time collaboration. Local workspaces remain separate and stored on this machine. See `../deploy/README.md` for the Docker stack, demo accounts, data volumes and backup/restore workflow. Switching workspaces waits for pending document writes before loading the new context.

The tab strip separately keeps its per-tab history in the webview's
`sessionStorage` under `blok:window-tabs:v1`; this is window state, not the page
storage. When running only the Vite preview in a browser, pages use that
browser's `localStorage` instead of native files.

The shared sidebar is imported from `src/shell/sidebar.ts` and editor code from
`src/full.ts`. Install the repository dependencies before building the desktop
package; Vite resolves those sources and their dependencies from the repository.
The desktop currently bundles the repository's Blok 2.1.0 source; its own Tauri
app version is 0.1.0. `defaultTools` contains only paragraphs, headings and
lists, so the desktop also registers Table, Database, DatabaseRow and
DatabaseComment explicitly for the slash menu and saved documents.
`src/editor.css` explicitly includes the root `src/` in Tailwind's source scan;
without it, editor controls and popovers lose their utility styles in desktop.
React Grab loads only in Vite/Tauri development, as in the reference desktop
project; it is excluded from the packaged app.

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

Tauri bundles the same TypeScript shell and editor used by the browser. On a fresh installation, the standalone package opens the embedded server setup. The smaller package opens a disk workspace. In the connection screen, choose **Se connecter à un autre serveur** and enter the Docker demo URL or an HTTPS server. The native adapter stores remote sessions in the OS keychain.

To preselect a server when building the native app, set `VITE_BLOK_SERVER_URL` for the build. An explicitly chosen server or an already active remote workspace takes precedence.

```sh
cd desktop
VITE_BLOK_SERVER_URL=http://localhost:8088 npm run tauri -- build --bundles app
```
