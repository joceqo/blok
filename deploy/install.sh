#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
env_file="${BLOK_ENV_FILE:-.env}"
if [[ ! -f "$env_file" ]]; then
  umask 077
  cp .env.example "$env_file"
  for key in POSTGRES_PASSWORD TICKET_SECRET INTERNAL_SECRET; do
    value=$(openssl rand -hex 32)
    # Values are hex; no shell or sed metacharacters.
    sed "s/^${key}=.*/${key}=${value}/" "$env_file" > "$env_file.new"
    mv "$env_file.new" "$env_file"
  done
  echo 'Created the environment file with generated secrets. Set DOMAIN, BOOTSTRAP_ADMIN_EMAIL and MAILER_* for SMTP (or optional Resend), then run install.sh again.'
  exit 0
fi
./stack.sh config --quiet
./stack.sh build --pull
./stack.sh up -d --wait --wait-timeout 180
./stack.sh ps
