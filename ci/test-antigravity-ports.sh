#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

awk '/^# Resolve and canonicalize all three listening ports/{copy=1} copy{print} copy&&/^export PORT CODE_SERVER_INTERNAL_PORT ANTIGRAVITY_SERVER_PORT$/{exit}' \
  "$ROOT/railway-entrypoint.sh" > "$TMP/ports.sh"

resolve() {
  # shellcheck disable=SC2016
  env -i PATH="$PATH" "$@" bash -c 'source "$1" >/dev/null; printf "%s %s %s" "$PORT" "$CODE_SERVER_INTERNAL_PORT" "$ANTIGRAVITY_SERVER_PORT"' bash "$TMP/ports.sh"
}

assert_ports() {
  local expected="$1"
  shift
  local actual
  actual="$(resolve "$@")"
  if [ "$actual" != "$expected" ]; then
    echo "Expected ports [$expected], got [$actual]" >&2
    exit 1
  fi
}

assert_ports "8080 8081 38000"
assert_ports "8081 8082 38000" PORT=8081
assert_ports "9000 8081 38000" PORT=9000 CODE_SERVER_INTERNAL_PORT=38000 ANTIGRAVITY_SERVER_PORT=38000
assert_ports "9000 8082 8081" PORT=9000 ANTIGRAVITY_SERVER_PORT=8081
assert_ports "9000 8082 8081" PORT=9000 CODE_SERVER_INTERNAL_PORT=8081 ANTIGRAVITY_SERVER_PORT=8081
assert_ports "38000 8081 38001" PORT=38000
assert_ports "9000 8081 8080" PORT=9000 ANTIGRAVITY_SERVER_PORT=08080
assert_ports "8080 8081 38000" PORT=invalid CODE_SERVER_INTERNAL_PORT=80 ANTIGRAVITY_SERVER_PORT=0
assert_ports "8080 8081 38000" PORT=80
assert_ports "8080 8081 38000" PORT=999999999999999999999999

grep -Fq 'exec dumb-init /usr/bin/node /usr/local/lib/antigravity-proxy.js' "$ROOT/railway-entrypoint.sh"
# shellcheck disable=SC2016
grep -Fq -- '--bind-addr "127.0.0.1:$CODE_SERVER_INTERNAL_PORT"' "$ROOT/railway-entrypoint.sh"

echo "Antigravity port resolution tests passed"
