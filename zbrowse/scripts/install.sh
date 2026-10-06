#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine is required." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi
if [[ ! -S /var/run/docker.sock ]]; then
  echo "Docker socket /var/run/docker.sock is unavailable." >&2
  exit 1
fi

bash scripts/prepare-env.sh .env .env.example

docker_gid="$(stat -c '%g' /var/run/docker.sock)"
if grep -q '^DOCKER_GID=' .env; then
  sed -i "s/^DOCKER_GID=.*/DOCKER_GID=${docker_gid}/" .env
else
  printf '\nDOCKER_GID=%s\n' "$docker_gid" >> .env
fi

bash scripts/validate.sh
browser_image="$(sed -n 's/^BROWSER_IMAGE=//p' .env | tail -n 1)"
browser_image="${browser_image:-zbrowse-browser:1.0.0}"

docker build -t "$browser_image" ./browser
docker compose up -d --build gateway

port_value="$(sed -n 's/^PORT=//p' .env | tail -n 1)"
echo "zBrowse is available at http://127.0.0.1:${port_value:-8090}"
