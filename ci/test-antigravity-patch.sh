#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/extension"
printf '%s\n' \
  'before' \
  'const port = Number(configuredPort) || (await this.getAvailableEphemeralPort());' \
  'after' > "$TMP/extension/extension.js"
chmod 640 "$TMP/extension/extension.js"

if "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 0900 2>/dev/null; then
  echo "Antigravity compatibility patch accepted a zero-padded privileged port" >&2
  exit 1
fi
if "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 08 2>/dev/null; then
  echo "Antigravity compatibility patch accepted a short zero-padded privileged port" >&2
  exit 1
fi
if "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 999999999999999999999999 2>/dev/null; then
  echo "Antigravity compatibility patch accepted an oversized integer" >&2
  exit 1
fi

"$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 38000
"$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 38000
grep -Fq 'const port = 38000; /* code-server-antigravity-fixed-port */' "$TMP/extension/extension.js"
[ "$(stat -c '%a' "$TMP/extension/extension.js")" = 640 ]

"$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 39000
grep -Fq 'const port = 39000; /* code-server-antigravity-fixed-port */' "$TMP/extension/extension.js"

"$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 08080
grep -Fq 'const port = 8080; /* code-server-antigravity-fixed-port */' "$TMP/extension/extension.js"

printf '%s\n' \
  'const port = 3000;' \
  'const port = Number(configuredPort) || (await this.getAvailableEphemeralPort());' > "$TMP/extension/extension.js"
"$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 38000
grep -Fq 'const port = 3000;' "$TMP/extension/extension.js"
grep -Fq 'const port = 38000; /* code-server-antigravity-fixed-port */' "$TMP/extension/extension.js"

printf '%s\n' \
  'const port = 3000;' \
  'const port = 4000;' > "$TMP/extension/extension.js"
if "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 38000 2>/dev/null; then
  echo "Antigravity compatibility patch accepted unrelated numeric ports" >&2
  exit 1
fi

if "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 1 2>/dev/null; then
  echo "Antigravity compatibility patch accepted a privileged port" >&2
  exit 1
fi

printf '%s\n' 'const unrelated = true;' > "$TMP/extension/extension.js"
if "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/extension" 38000 2>/dev/null; then
  echo "Antigravity compatibility patch accepted a missing hook" >&2
  exit 1
fi

echo "Antigravity compatibility patch tests passed"
