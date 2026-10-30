#!/usr/bin/env bash
# CI-only real gateway containment, scoped to an unprivileged, isolated OCI store.
set -euo pipefail
test "$(id -u)" -ne 0
for tool in docker podman catatonit slirp4netns python3 node; do
  command -v "$tool" >/dev/null
done
test -n "$RUNNER_TEMP"
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
test -d "$XDG_RUNTIME_DIR/systemd"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
CI_TMP="$(mktemp -d "$RUNNER_TEMP/zbrowse-ci-XXXXXXXX")"
chmod 0700 "$CI_TMP"
mkdir -m 0700 "$CI_TMP/store" "$CI_TMP/run"
IMAGE="localhost/zbrowse-gateway-ci:$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
PORT="$((18000 + GITHUB_RUN_ID % 10000))"
export PORT DOCKER_HOST="unix://$CI_TMP/podman.sock" DOCKER_GID="$(id -g)"
api_pid=""
cleanup() {
  rc=$?
  if test -n "$api_pid"; then
    docker compose -f docker-compose.yml -f "$CI_TMP/override.yml" down --remove-orphans >/dev/null 2>&1 || true
    kill "$api_pid" >/dev/null 2>&1 || true
    wait "$api_pid" >/dev/null 2>&1 || true
  fi
  case "$CI_TMP" in
    "$RUNNER_TEMP"/zbrowse-ci-*)
      cleanup_rc=0
      if test -d "$CI_TMP/store"; then
        graph="$(podman --root="$CI_TMP/store" --runroot="$CI_TMP/run" --cgroup-manager=cgroupfs info --format '{{.Store.GraphRoot}}')" || cleanup_rc=1
        if test "$cleanup_rc" = 0 && test "$graph" = "$CI_TMP/store"; then
          podman --root="$CI_TMP/store" --runroot="$CI_TMP/run" --cgroup-manager=cgroupfs system reset --force >/dev/null 2>&1 || cleanup_rc=1
        else
          cleanup_rc=1
        fi
      fi
      if test "$cleanup_rc" = 0; then
        rm -rf -- "$CI_TMP" || cleanup_rc=1
      fi
      if test "$rc" = 0 && test "$cleanup_rc" != 0; then
        echo "Rootless test image store cleanup failed" >&2
        exit 1
      fi
      ;;
  esac
  exit "$rc"
}
trap cleanup EXIT
export CI_TMP IMAGE
python3 - <<'PY'
import json, os
from pathlib import Path
d = Path(os.environ["CI_TMP"])
js = "fetch('http://127.0.0.1:' + (process.env.PORT || '8090') + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
health_command = 'node -e "' + js + '"'
content = (
    "services:\n  gateway:\n"
    "    image: " + os.environ["IMAGE"] + "\n"
    "    userns_mode: keep-id\n"
    "    network_mode: slirp4netns\n"
    "    networks: !reset []\n"
    "    volumes:\n      - " + str(d / "podman.sock") + ":/var/run/docker.sock\n"
    "    healthcheck:\n      test: [CMD-SHELL, " + json.dumps(health_command) + "]\n"
)
(d / "override.yml").write_text(content, encoding="utf-8")
PY
cd zbrowse
nice -n 15 podman --root="$CI_TMP/store" --runroot="$CI_TMP/run" --cgroup-manager=cgroupfs build --tag "$IMAGE" ./gateway
podman --root="$CI_TMP/store" --runroot="$CI_TMP/run" --cgroup-manager=cgroupfs system service --time 0 "unix://$CI_TMP/podman.sock" >"$CI_TMP/api.log" 2>&1 &
api_pid=$!
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  test -S "$CI_TMP/podman.sock" && break
  sleep 1
done
test -S "$CI_TMP/podman.sock"
chmod 0660 "$CI_TMP/podman.sock"
test "$(stat -c '%a' "$CI_TMP/podman.sock")" = 660
docker compose -f docker-compose.yml -f "$CI_TMP/override.yml" config --format json | python3 -c 'import json,sys; s=json.load(sys.stdin)["services"]["gateway"]; assert s["network_mode"] == "slirp4netns" and "networks" not in s; assert s["read_only"] and "ALL" in s["cap_drop"]; assert all(p.get("host_ip") == "127.0.0.1" for p in s["ports"])'
docker compose -f docker-compose.yml -f "$CI_TMP/override.yml" up -d --no-build gateway
healthy=false
for attempt in $(seq 1 30); do
  if podman --root="$CI_TMP/store" --runroot="$CI_TMP/run" --cgroup-manager=cgroupfs healthcheck run zbrowse-gateway >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if test "$healthy" != true; then
  echo "Gateway did not pass real container healthcheck" >&2
  exit 1
fi
test "$(docker inspect --format '{{.State.Health.Status}}' zbrowse-gateway)" = healthy
node ../tests/zbrowse.gateway-runtime.test.mjs zbrowse-gateway
echo "zBrowse isolated rootless gateway containment passed"
