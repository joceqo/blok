<<<<<<< HEAD
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# The current release can serve requests throughout a source build.
./stack.sh config --quiet
./stack.sh build --pull
# Keep all writers stopped after taking the snapshot so the new processes start
# from the same journal and PostgreSQL state as the recovery copy.
BLOK_BACKUP_STOP_AFTER_SUCCESS=1 ./backup.sh
./stack.sh up -d --wait --wait-timeout 180
||||||| f8ef3c6b39
=======
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./backup.sh
# Build failure leaves the old service running. Build before replacement.
./stack.sh build --pull
./stack.sh up -d --wait --wait-timeout 180
>>>>>>> origin/fix/self-host-review
