#!/usr/bin/env bash
set -euo pipefail
# Resolve an explicit env file before entering deploy/, matching the caller's cwd.
env_file="${DEMO_ENV_FILE:-}"
if [[ -n "$env_file" && "$env_file" != /* ]]; then env_file="$PWD/$env_file"; fi
cd "$(dirname "$0")"
env_file="${env_file:-$PWD/.env.demo}"
selection_file="$env_file.room"
if [[ ! -f "$env_file" ]]; then
  umask 077
  for key in POSTGRES_PASSWORD TICKET_SECRET INTERNAL_SECRET; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
  done > "$env_file"
fi
selected=''
valid_page() { [[ "$1" =~ ^[a-zA-Z0-9_-]{1,128}$ ]]; }
read_selection() {
  selected=''
  if [[ -f "$selection_file" ]]; then
    selected=$(cat "$selection_file")
    valid_page "${selected#workspace:}" || { echo "Invalid room selection in $selection_file" >&2; return 1; }
  fi
}
compose() {
  local args=(--env-file "$env_file" -f compose.demo.yaml)
  local page="$selected" workspace='' target="$selected"
  if [[ -n "$selected" ]]; then args+=(-f compose.demo-room.yaml); fi
  if [[ "$selected" == workspace:* ]]; then
    workspace="${selected#workspace:}"
    page=''
    target='--workspace'
  fi
  BLOK_NODE_ROOM_PAGE="$page" BLOK_NODE_ROOM_WORKSPACE="$workspace" BLOK_ROOM_TARGET="$target" docker compose "${args[@]}" "$@"
}

# A forced kill is not a completed drain. Keep the current selection on disk if
# the old owner fails to exit cleanly, so it can recover from its journal.
drain() {
  local container
  container=$(compose ps -aq "$1")
  if [[ -z "$container" ]]; then
    # Recovery after a failed boot: a room container that was never created
    # cannot hold the journal. room-disable also probes its flock below.
    [[ "${2:-}" == allow-missing ]] && return 0
    echo "Start the demo before switching its room owner." >&2
    return 1
  fi
  compose stop -t 90 "$1"
  [[ $(docker inspect -f '{{.State.Running}}:{{.State.ExitCode}}' "$container") == false:0 ]] || {
    echo "$1 did not drain cleanly. Start the current owner and retry." >&2; return 1;
  }
}
# Une clé Resend dans .env.demo fait basculer la démo sur un vrai envoi : le
# répertoire de mail de développement doit alors être vide, sinon il est choisi
# en premier et aucun message ne part (mail.go, ordre de sélection).
if grep -qE '^RESEND_API_KEY=.+' "$env_file" 2>/dev/null; then
  export DEV_MAIL_DIRECTORY=
  mail_backend='resend (envoi réel)'
else
  mail_backend="development (boîte locale sur :${DEMO_MAIL_PORT:-8089})"
fi
seed() {
  compose exec -T app mkdir -p /data/mail
  compose run --rm --no-deps seed
  compose exec -T app touch /data/.demo-seeded
}
action="${1:-start}"
[[ $# == 0 ]] || shift
setup_mode=0
[[ "${1:-}" == "--setup" ]] && { setup_mode=1; shift; }
case "$action" in
  start|stop|room-enable|room-enable-workspace|room-disable)
    if ! mkdir "$env_file.room-lock"; then echo "Another demo transition holds $env_file.room-lock" >&2; exit 1; fi
    trap 'rmdir "$env_file.room-lock"' EXIT
    ;;
esac
read_selection
case "$action" in
  room-enable|room-enable-workspace)
    name="${1:-}"
    valid_page "$name" || { echo 'Supply a valid page ID or workspace slug/ID.' >&2; exit 1; }
    if [[ "$action" == room-enable-workspace ]]; then
      ws=$(compose exec -T postgres psql -v ON_ERROR_STOP=1 -U blok -d blok -Atqc "SELECT id FROM workspaces WHERE slug='$name' OR id='$name' ORDER BY (slug='$name') DESC LIMIT 1")
      valid_page "$ws" || { echo 'Workspace not found or unsupported canonical ID.' >&2; exit 1; }
      candidate="workspace:$ws"
    else
      active=$(compose exec -T postgres psql -v ON_ERROR_STOP=1 -U blok -d blok -Atqc "SELECT 1 FROM pages WHERE id='$name' AND NOT deleted AND NOT trashed")
      [[ "$active" == 1 ]] || { echo "That page is missing or in the trash." >&2; exit 1; }
      candidate="$name"
    fi
    if [[ -n "$selected" && "$selected" != "$candidate" ]]; then echo "Disable the current Node room selection first." >&2; exit 1; fi
    if [[ "$selected" == "$candidate" ]]; then compose up -d --wait --wait-timeout 180; exit 0; fi
    selected="$candidate"
    compose build app node web room
    drain app
    printf '%s\n' "$selected" > "$selection_file.tmp"
    mv "$selection_file.tmp" "$selection_file"
    compose up -d --wait --wait-timeout 180
    echo "Node serves $selected."
    ;;
  room-disable)
    [[ -n "$selected" ]] || { echo 'Go already serves every page.'; exit 0; }
    drain room allow-missing
    drain app allow-missing
    compose rm -f room
    # The stopped process can no longer hold a flock. Also test the actual
    # Go journal lock before enabling its owner; a second holder must fail closed.
    compose run --rm --no-deps --entrypoint python3 room -c '
import fcntl, hashlib, os, pathlib, sys
root=pathlib.Path("/data/collab")
selection=sys.argv[1]
if selection.startswith("workspace:"):
    # Both hosts are stopped. Include new, trashed and orphaned journals.
    # Handoff must not depend on the workspace index at activation time.
    locks=root.glob("*.journal/lock")
else:
    locks=[root/(hashlib.sha256(selection.encode()).hexdigest()+".journal")/"lock"]
for path in locks:
    try:
        handle=path.open("rb")
    except FileNotFoundError:
        continue  # A never-opened page may have no journal yet.
    with handle:
        fcntl.flock(handle,fcntl.LOCK_EX | fcntl.LOCK_NB)
' "$selected"
    rm "$selection_file"
    selected=''
    compose up -d --wait --wait-timeout 180
    echo 'Go serves every page.'
    ;;
  start)
    compose build
    if [[ $setup_mode == 1 ]]; then
      # Instance vierge : pas d'amorçage par variable, donc l'assistant de
      # premier démarrage prend la main.
      BOOTSTRAP_ADMIN_EMAIL= BOOTSTRAP_WORKSPACE_SLUG= BOOTSTRAP_WORKSPACE_NAME= \
        compose up -d --wait --wait-timeout 180
      printf '%s\n' "Blok: http://localhost:${DEMO_WEB_PORT:-8088}" "Backend mail : $mail_backend" \
        'Premier démarrage : ouvrez l’adresse, l’assistant prend la main.'
      exit 0
    fi
    compose up -d --wait --wait-timeout 180
    if [[ -z "${DEV_MAIL_DIRECTORY-unset}" ]]; then
      # Le semis lit les codes dans le répertoire de mail ; sans lui, les
      # comptes de démonstration ne peuvent pas être créés.
      printf '%s\n' "Blok: http://localhost:${DEMO_WEB_PORT:-8088}" "Backend mail : $mail_backend" \
        'Comptes de démonstration non semés : ils naissent des codes lus dans la boîte locale.'
      exit 0
    fi
    if ! compose exec -T app test -f /data/.demo-seeded; then seed; fi
    printf '%s\n' "Blok: http://localhost:${DEMO_WEB_PORT:-8088}" "Backend mail : $mail_backend" "E-mails: http://localhost:${DEMO_MAIL_PORT:-8089}" 'Admin: admin@example.test' 'Membre ajouté: membre@example.test' 'Demande d’accès: demandeur@example.test'
    ;;
  seed) seed ;;
  stop) compose stop ;;
  status) compose ps ;;
  logs) compose logs --tail 100 "$@" ;;
  compose) compose "$@" ;;
  *) echo 'Usage: demo.sh [start|stop|status|seed|room-enable PAGE|room-enable-workspace SLUG|room-disable|logs|compose ...]' >&2; exit 1 ;;
esac
