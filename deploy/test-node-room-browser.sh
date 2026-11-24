#!/usr/bin/env bash
# Opt-in. Run from any directory with Docker, Node, Playwright Chromium and root JS dependencies installed.
set -euo pipefail
workspace=0
for option in "$@"; do
case "$option" in
  --help|-h)
    cat <<'HELP'
Usage: deploy/test-node-room-browser.sh [--workspace] [--keep]
Starts an isolated local Docker demo and runs two headless Chromium editors.
Install the root JS dependencies and the Playwright Chromium browser first.
--workspace exercises all documents of one workspace, a new page and isolation from a second workspace.
It defaults to 18124 (web), 18125 (mail), and 172.30.214.
--keep leaves the document, accounts and Docker volumes available for manual testing.
Override DEMO_WEB_PORT, DEMO_MAIL_PORT and DEMO_NETWORK_PREFIX if their defaults
(18120, 18121 and 172.30.211) are already used.
HELP
    exit 0 ;;
  --keep) export BLOK_ROOM_SMOKE_KEEP=1 ;;
  --workspace) workspace=1 ;;
  *) echo 'Use --help for usage.' >&2; exit 2 ;;
esac
done
cd "$(dirname "$0")/.."
umask 077
state=$(mktemp -d "${BLOK_ROOM_SMOKE_TMPDIR:-${TMPDIR:-/tmp}}/blok-room-browser.XXXXXXXX")
export COMPOSE_PROJECT_NAME="blok-room-browser-$(openssl rand -hex 5)"
export DEMO_ENV_FILE="$state/stack.env"
if [[ "$workspace" == 1 ]]; then
  export DEMO_WEB_PORT=${DEMO_WEB_PORT:-18124} DEMO_MAIL_PORT=${DEMO_MAIL_PORT:-18125}
  export DEMO_NETWORK_PREFIX=${DEMO_NETWORK_PREFIX:-172.30.214}
fi
export BLOK_ROOM_SMOKE_WORKSPACE="$workspace"
export DEMO_WEB_PORT=${DEMO_WEB_PORT:-18120}
export DEMO_MAIL_PORT=${DEMO_MAIL_PORT:-18121}
export DEMO_NETWORK_PREFIX=${DEMO_NETWORK_PREFIX:-172.30.211}
export DEV_MAIL_DIRECTORY=/data/mail RESEND_API_KEY=''
{
  printf 'COMPOSE_PROJECT_NAME=%s\nDEMO_WEB_PORT=%s\nDEMO_MAIL_PORT=%s\nDEMO_NETWORK_PREFIX=%s\n' "$COMPOSE_PROJECT_NAME" "$DEMO_WEB_PORT" "$DEMO_MAIL_PORT" "$DEMO_NETWORK_PREFIX"
  for key in POSTGRES_PASSWORD TICKET_SECRET INTERNAL_SECRET; do printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"; done
  printf 'DEV_MAIL_DIRECTORY=/data/mail\nRESEND_API_KEY=\n'
} > "$DEMO_ENV_FILE"

finish() {
  if [[ ${BLOK_ROOM_SMOKE_KEEP:-0} == 1 ]]; then
    printf 'Dedicated Docker project %s retained.\nEnvironment file: %s\n' "$COMPOSE_PROJECT_NAME" "$DEMO_ENV_FILE"
    printf 'To stop this project: DEMO_ENV_FILE=%q ./deploy/demo.sh compose down\n' "$DEMO_ENV_FILE"
  else
    ./deploy/demo.sh compose down --remove-orphans -v >/dev/null
    rm -rf "$state"
  fi
}
trap finish EXIT
node -e "require.resolve('@playwright/test')"
./deploy/demo.sh compose up -d --wait --wait-timeout 180 --build postgres node app web mailbox
node desktop/src/cloud/node-room-browser-smoke.mjs
