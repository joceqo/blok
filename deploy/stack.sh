<<<<<<< HEAD
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec docker compose --env-file "${BLOK_ENV_FILE:-.env}" -f "${BLOK_COMPOSE_FILE:-compose.yaml}" "$@"
||||||| f8ef3c6b39
=======
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec docker compose --env-file .env -f compose.yaml "$@"
>>>>>>> origin/fix/self-host-review
