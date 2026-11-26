<<<<<<< HEAD
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
backup_dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd)
[[ ! -f "$backup_dir/complete" ]] || { echo 'Backup destination already complete' >&2; exit 1; }

# The room projects its last writes through the API. Keep app and PostgreSQL
# running until the room exits, then stop all other writers before pg_dump.
writers=(web room media app)
originally_running=()
for service in "${writers[@]}"; do
  if [[ -n "$(./stack.sh ps --status running -q "$service")" ]]; then
    originally_running+=("$service")
  fi
done
app_container=$(./stack.sh ps -aq app)
[[ -n "$app_container" ]] || { echo 'API container missing' >&2; exit 1; }
restart() {
  local status=$?
  trap - EXIT
  if [[ "$status" == 0 && "${BLOK_BACKUP_STOP_AFTER_SUCCESS:-0}" == 1 ]]; then exit 0; fi
  local i
  for (( i=${#originally_running[@]} - 1; i>=0; i-- )); do
    ./stack.sh start "${originally_running[i]}" >/dev/null || status=1
  done
  exit "$status"
}
trap restart EXIT
for service in "${writers[@]}"; do
  container=$(./stack.sh ps -aq "$service")
  [[ -n "$container" ]] || continue
  ./stack.sh stop "$service"
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
  [[ "$exit_code" == 0 ]] || { echo "$service exited with $exit_code; refusing incomplete backup" >&2; exit 1; }
done
./stack.sh exec -T postgres pg_dump -U blok -d blok -Fc > "$backup_dir/database.dump"
./stack.sh run --rm --no-deps -T --entrypoint tar app -C /data -czf - . > "$backup_dir/state.tar.gz"
if [[ -f source-commit ]]; then
  cp source-commit "$backup_dir/source-commit"
elif git -C .. rev-parse HEAD > "$backup_dir/source-commit" 2>/dev/null; then
  :
else
  rm -f "$backup_dir/source-commit"
fi
./stack.sh ps -aq | while IFS= read -r container; do
  docker inspect --format '{"name":{{json .Name}},"image":{{json .Config.Image}},"id":{{json .Image}}}' "$container"
done > "$backup_dir/images.jsonl"
printf '%s\n' 'Restore requires the deployment .env secrets kept separately.' > "$backup_dir/README.txt"
touch "$backup_dir/complete"
echo "Backup completed: $backup_dir"
||||||| f8ef3c6b39
=======
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
backup_dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd)
[[ ! -f "$backup_dir/complete" ]] || { echo 'Backup destination already complete' >&2; exit 1; }
# Keep the API alive while Blok drains; the app owns orderly shutdown.
./stack.sh stop app
trap './stack.sh start app >/dev/null' EXIT
app_container=$(./stack.sh ps -aq app)
[[ -n "$app_container" ]] || { echo 'App container missing; refusing incomplete backup' >&2; exit 1; }
app_exit=$(docker inspect --format '{{.State.ExitCode}}' "$app_container")
[[ "$app_exit" == 0 ]] || { echo 'App did not drain cleanly; inspect logs before backing up' >&2; exit 1; }
./stack.sh exec -T postgres pg_dump -U blok -d blok -Fc > "$backup_dir/database.dump"
./stack.sh run --rm --no-deps -T --entrypoint tar app -C /data -czf - . > "$backup_dir/state.tar.gz"
git -C .. rev-parse HEAD > "$backup_dir/source-commit"
./stack.sh ps -aq | while IFS= read -r container; do
  docker inspect --format '{"name":{{json .Name}},"image":{{json .Config.Image}},"id":{{json .Image}}}' "$container"
done > "$backup_dir/images.jsonl"
printf '%s\n' 'Restore requires the deployment .env secrets kept separately.' > "$backup_dir/README.txt"
touch "$backup_dir/complete"
echo "Backup completed: $backup_dir"
>>>>>>> origin/fix/self-host-review
