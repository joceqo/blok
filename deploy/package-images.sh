#!/usr/bin/env bash
set -euo pipefail
[[ $# -ge 1 && $# -le 2 ]] || { echo 'Usage: package-images.sh OUTPUT_DIRECTORY [linux/amd64|linux/arm64]' >&2; exit 1; }
out="$1"
platform="${2:-linux/amd64}"
case "$platform" in linux/amd64|linux/arm64) ;; *) echo 'Unsupported platform' >&2; exit 1 ;; esac
# Keep an existing package untouched.
mkdir "$out"
out=$(cd "$out" && pwd)
cd "$(dirname "$0")"
root=$(cd .. && pwd)
commit=$(git -C "$root" rev-parse HEAD)
tag="${commit:0:12}-${platform#linux/}"
app="blok-cloud-app:$tag"
web="blok-cloud-web:$tag"
for target in service web; do
  image="$app"
  if [[ "$target" == web ]]; then image="$web"; fi
  docker buildx build --platform "$platform" --target "$target" --tag "$image" --load -f Dockerfile "$root"
done
docker save -o "$out/images.tar" "$app" "$web"
cp compose.images.yaml "$out/compose.yaml"
cp stack.sh install.sh upgrade.sh backup.sh restore.sh "$out/"
sed -e "s|^APP_IMAGE=.*|APP_IMAGE=$app|" -e "s|^WEB_IMAGE=.*|WEB_IMAGE=$web|" .env.example > "$out/.env.example"
printf '%s\n' "$commit" > "$out/source-commit"
echo "Package complete: $out"
