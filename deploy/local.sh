#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: deploy/local.sh install|start|stop|status|logs'
  echo 'install prépare les images et démarre Blok. start réutilise les images locales.'
}

action=${1:-start}
case "$action" in
  -h|--help) usage; exit 0 ;;
  install|start|stop|status|logs) ;;
  *) usage >&2; exit 2 ;;
esac

# A separate Compose project keeps PostgreSQL and document volumes independent
# of both the public server and the pre-seeded demo.
instance=${BLOK_LOCAL_INSTANCE:-}
if [[ -n "$instance" && ! "$instance" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
  echo 'BLOK_LOCAL_INSTANCE doit contenir 1 à 31 lettres minuscules, chiffres ou tirets.' >&2
  exit 2
fi
project="blok-tauri-local${instance:+-$instance}"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/blok/$project"
env_file="$config_dir/compose.env"
cd "$(dirname "$0")"
# These settings belong to this project. Other Blok deployments may export
# different credentials, origins, networks or ports in the same terminal.
unset COMPOSE_PROJECT_NAME DEMO_WEB_PORT DEMO_NETWORK_PREFIX POSTGRES_PASSWORD TICKET_SECRET INTERNAL_SECRET
unset AI_ENCRYPTION_KEY ALLOWED_ORIGINS LOCAL_S3_ACCESS_KEY LOCAL_S3_SECRET_KEY
compose() {
  docker compose -p "$project" --env-file "$env_file" -f compose.demo.yaml -f compose.local.yaml "$@"
}

if [[ ! -f "$env_file" ]]; then
  if [[ "$action" != install ]]; then
    echo 'Préparez le serveur local avec ./deploy/local.sh install.' >&2
    exit 1
  fi
  volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$project")
  if [[ -n "$volumes" ]]; then
    echo "Les volumes de $project existent déjà. Restaurez $env_file avant de les ouvrir." >&2
    exit 1
  fi
  port=${BLOK_LOCAL_PORT:-18150}
  prefix=${BLOK_LOCAL_NETWORK_PREFIX:-172.30.250}
  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
    echo 'BLOK_LOCAL_PORT doit être un port TCP entre 1 et 65535.' >&2; exit 2
  fi
  octet='(0|[1-9][0-9]{0,2})'
  if [[ ! "$prefix" =~ ^$octet\.$octet\.$octet$ ]] || (( BASH_REMATCH[1] > 255 || BASH_REMATCH[2] > 255 || BASH_REMATCH[3] > 255 )); then
    echo 'BLOK_LOCAL_NETWORK_PREFIX doit contenir trois octets IPv4 (ex. 172.30.250).' >&2; exit 2
  fi
  umask 077
  mkdir -p "$config_dir"
  tmp=$(mktemp "$config_dir/.compose.env.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  {
    for key in POSTGRES_PASSWORD TICKET_SECRET INTERNAL_SECRET LOCAL_S3_SECRET_KEY; do
      value=$(openssl rand -hex 32)
      printf '%s=%s\n' "$key" "$value"
    done
    access_key=$(openssl rand -hex 10)
    printf 'LOCAL_S3_ACCESS_KEY=%s\n' "$access_key"
    printf 'DEMO_WEB_PORT=%s\nDEMO_NETWORK_PREFIX=%s\n' "$port" "$prefix"
  } > "$tmp"
  # Parallel installs must never replace one another's database password.
  ln "$tmp" "$env_file" || [[ -f "$env_file" ]]
fi

if [[ "$action" == install ]]; then
  if [[ -n "${BLOK_LOCAL_APP_IMAGE:-}${BLOK_LOCAL_WEB_IMAGE:-}" ]]; then
    : "${BLOK_LOCAL_APP_IMAGE:?Set both local image tags}" "${BLOK_LOCAL_WEB_IMAGE:?Set both local image tags}"
    docker image inspect "$BLOK_LOCAL_APP_IMAGE" "$BLOK_LOCAL_WEB_IMAGE" >/dev/null
    docker tag "$BLOK_LOCAL_APP_IMAGE" "$project-app:local"
    docker tag "$BLOK_LOCAL_WEB_IMAGE" "$project-web:local"
  else
    compose build app web
  fi
  compose pull --policy missing postgres s3
fi

services=(postgres s3 app room media web)
case "$action" in
  install|start)
    compose up -d --pull never --no-build --wait --wait-timeout 180 "${services[@]}"
    address=$(compose port web 80)
    echo "Blok est prêt sur http://localhost:${address##*:}"
    ;;
  stop) compose stop "${services[@]}" ;;
  status) compose ps --all "${services[@]}" ;;
  logs) compose logs --tail 100 "${services[@]}" ;;
esac
