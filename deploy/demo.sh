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
    valid_page "$selected" || { echo "Invalid room selection in $selection_file" >&2; return 1; }
  fi
}
compose() {
  local args=(--env-file "$env_file" -f compose.demo.yaml)
  if [[ -n "$selected" ]]; then args+=(-f compose.demo-room.yaml); fi
  BLOK_NODE_ROOM_PAGE="$selected" docker compose "${args[@]}" "$@"
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
  start|stop|room-enable|room-disable)
    if ! mkdir "$env_file.room-lock"; then echo "Another demo transition holds $env_file.room-lock" >&2; exit 1; fi
    trap 'rmdir "$env_file.room-lock"' EXIT
    ;;
esac
read_selection
case "$action" in
  room-enable)
    page="${1:-}"
    valid_page "$page" || { echo 'Supply an existing page ID (letters, digits, hyphens or underscores).' >&2; exit 1; }
    if [[ -n "$selected" && "$selected" != "$page" ]]; then echo "Disable the current Node room first." >&2; exit 1; fi
    if [[ "$selected" == "$page" ]]; then compose up -d --wait --wait-timeout 180; exit 0; fi
    active=$(compose exec -T postgres psql -U blok -d blok -Atqc "SELECT 1 FROM pages WHERE id='$page' AND NOT deleted AND NOT trashed")
    [[ "$active" == 1 ]] || { echo "That page is missing or in the trash." >&2; exit 1; }
    selected="$page"
    compose build app node room
    drain app
    printf '%s\n' "$page" > "$selection_file.tmp"
    mv "$selection_file.tmp" "$selection_file"
    compose up -d --wait --wait-timeout 180
    echo "Node serves page $page."
    ;;
  room-disable)
    [[ -n "$selected" ]] || { echo 'Go already serves every page.'; exit 0; }
    drain room allow-missing
    drain app allow-missing
    compose rm -f room
    # The stopped process can no longer hold a flock. Also test the actual
    # Go journal lock before enabling its owner; a second holder must fail closed.
    compose run --rm --no-deps --entrypoint python3 room -c '
import fcntl, hashlib, os, sys
root="/data/collab/"+hashlib.sha256(sys.argv[1].encode()).hexdigest()+".journal"
try:
    lock=open(os.path.join(root,"lock"),"rb")
except FileNotFoundError:
    sys.exit(0)  # A room that never booted may not have created this journal.
with lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
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
  *) echo 'Usage: demo.sh [start|stop|status|seed|room-enable PAGE|room-disable|logs|compose ...]' >&2; exit 1 ;;
esac
