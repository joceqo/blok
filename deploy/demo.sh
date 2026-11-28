#!/usr/bin/env bash
set -euo pipefail
# Resolve an explicit env file before entering deploy/, matching the caller's cwd.
env_file="${DEMO_ENV_FILE:-}"
if [[ -n "$env_file" && "$env_file" != /* ]]; then env_file="$PWD/$env_file"; fi
cd "$(dirname "$0")"
env_file="${env_file:-$PWD/.env.demo}"
if [[ ! -f "$env_file" ]]; then
  umask 077
  for key in POSTGRES_PASSWORD TICKET_SECRET INTERNAL_SECRET; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
  done > "$env_file"
fi
compose() {
  docker compose --env-file "$env_file" -f compose.demo.yaml "$@"
}
# An explicit development sink takes precedence, including when testing a mail
# adapter. Otherwise supplying SMTP or Resend selects real outbound delivery.
mail_backend=$(compose config --environment | awk '
  /^DEV_MAIL_DIRECTORY=/ { directory=substr($0,20); specified=1 }
  /^(MAILER_HOST|SMTP_HOST)=./ { smtp=1 }
  /^RESEND_API_KEY=./ { resend=1 }
  END {
    if (specified && directory != "") print "development"
    else if (smtp) print "smtp"
    else if (resend) print "resend"
    else if (specified) print "none"
    else print "development"
  }')
if [[ "$mail_backend" == smtp || "$mail_backend" == resend ]]; then export DEV_MAIL_DIRECTORY=; fi

seed() {
  if [[ "$mail_backend" == smtp || "$mail_backend" == resend ]]; then
    echo 'Envoi réel configuré. Les comptes de démonstration sont désactivés.'
    return
  fi
  chmod 600 "$env_file"
  for key in DEMO_ADMIN_PASSWORD DEMO_MEMBER_PASSWORD DEMO_REQUESTER_PASSWORD; do
    if [[ -z "${!key:-}" ]] && ! grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$env_file"; then
      printf '\n%s=%s\n' "$key" "$(openssl rand -hex 20)" >> "$env_file"
    fi
  done
  compose run --rm --no-deps seed
  printf '%s\n' "Mots de passe de démonstration : DEMO_ADMIN_PASSWORD, DEMO_MEMBER_PASSWORD, DEMO_REQUESTER_PASSWORD (environnement ou $env_file)."
}
action="${1:-start}"
[[ $# == 0 ]] || shift
setup_mode=0
[[ "${1:-}" == "--setup" ]] && { setup_mode=1; shift; }
case "$action" in
  start|stop|seed)
    if ! mkdir "$env_file.room-lock"; then echo "Another demo transition holds $env_file.room-lock" >&2; exit 1; fi
    trap 'rmdir "$env_file.room-lock"' EXIT
    ;;
esac
# Keep a first-run demo in interactive mode across stop/start and compose up.
if [[ "$action" == start && "$setup_mode" == 1 ]]; then touch "$env_file.setup"; fi
if [[ -f "$env_file.setup" ]] || compose config --environment | grep -Fx 'BOOTSTRAP_ADMIN_EMAIL=' >/dev/null; then
  setup_mode=1
  export BOOTSTRAP_ADMIN_EMAIL= BOOTSTRAP_WORKSPACE_SLUG= BOOTSTRAP_WORKSPACE_NAME=
fi
case "$action" in
  start)
    compose build
    compose up -d --wait --wait-timeout 180
    if [[ $setup_mode == 1 ]]; then
      echo 'Configuration interactive depuis le navigateur.'
    else
      seed
    fi
    printf '%s\n' "Blok: http://$(compose port web 80)" "Backend mail : $mail_backend"
    if [[ "$mail_backend" == development ]]; then printf '%s\n' "E-mails: http://$(compose port mailbox 8025)"; fi
    ;;
  seed)
    if [[ $setup_mode == 1 ]]; then echo 'La configuration interactive est activée sur cette instance.'; exit 1; fi
    seed
    ;;
  stop) compose stop ;;
  status) compose ps ;;
  logs) compose logs --tail 100 "$@" ;;
  compose) compose "$@" ;;
  *) echo 'Usage: demo.sh [start|stop|status|seed|logs|compose ...]' >&2; exit 1 ;;
esac
