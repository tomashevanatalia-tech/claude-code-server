#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat > "$TMP/bin/code-server" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    --extensions-dir)
      extensions_dir="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done
target="$extensions_dir/google.google-antigravity-1.2.0"
mkdir -p "$target"
cat > "$target/package.json" <<'JSON'
{"publisher":"google","name":"google-antigravity","version":"1.2.0"}
JSON
if [ "${FAKE_BAD_HOOK:-}" = "1" ]; then
  printf '%s\n' 'const unrelated = true;' > "$target/extension.js"
else
  printf '%s\n' 'const port = Number(configuredPort) || (await this.getAvailableEphemeralPort());' > "$target/extension.js"
fi
FAKE
chmod +x "$TMP/bin/code-server"
touch "$TMP/google-antigravity-1.2.0.vsix"

mkdir -p "$TMP/extensions/google.google-antigravity-9.9.9" \
  "$TMP/quarantine/google.google-antigravity-2.0.0.1" \
  "$TMP/quarantine/google.google-antigravity-2.0.1.2" \
  "$TMP/quarantine/google.google-antigravity-2.0.2.3" \
  "$TMP/quarantine/google.google-antigravity-2.0.3.4"
cat > "$TMP/extensions/extensions.json" <<'JSON'
[
  {"identifier":{"id":"unrelated.extension"},"version":"3.0.0","relativeLocation":"unrelated.extension-3.0.0"},
  {"identifier":{"id":"Google.google-antigravity"},"version":"1.2.0","relativeLocation":"google.google-antigravity-1.2.0"},
  {"identifier":{"id":"Google.google-antigravity"},"version":"9.9.9","relativeLocation":"google.google-antigravity-9.9.9"}
]
JSON
chmod 640 "$TMP/extensions/extensions.json"
PATH="$TMP/bin:$PATH" "$ROOT/ci/sync-antigravity-extension.sh" \
  "$TMP/extensions" "$TMP/google-antigravity-1.2.0.vsix" 1.2.0 38000 \
  "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/quarantine" >/dev/null

grep -Fq 'const port = 38000;' "$TMP/extensions/google.google-antigravity-1.2.0/extension.js"
test ! -e "$TMP/extensions/google.google-antigravity-9.9.9"
find "$TMP/quarantine" -maxdepth 1 -type d -name 'google.google-antigravity-9.9.9.*' | grep -q .
test "$(find "$TMP/quarantine" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 3
test "$(stat -c '%a' "$TMP/extensions/extensions.json")" = 640
/usr/bin/node -e '
  const entries = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!entries.some((entry) => entry.identifier.id === "unrelated.extension")) process.exit(1);
  if (!entries.some((entry) => entry.version === "1.2.0")) process.exit(1);
  if (entries.some((entry) => entry.version === "9.9.9")) process.exit(1);
' "$TMP/extensions/extensions.json"

mkdir -p "$TMP/bad-extensions/google.google-antigravity-9.9.9"
cat > "$TMP/bad-extensions/extensions.json" <<'JSON'
[
  {"identifier":{"id":"Google.google-antigravity"},"version":"9.9.9","relativeLocation":"google.google-antigravity-9.9.9"}
]
JSON
if FAKE_BAD_HOOK=1 PATH="$TMP/bin:$PATH" "$ROOT/ci/sync-antigravity-extension.sh" \
  "$TMP/bad-extensions" "$TMP/google-antigravity-1.2.0.vsix" 1.2.0 38000 \
  "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/bad-quarantine" 2>/dev/null; then
  echo "Antigravity sync accepted an incompatible extension hook" >&2
  exit 1
fi
test ! -e "$TMP/bad-extensions/google.google-antigravity-9.9.9"
test ! -e "$TMP/bad-extensions/google.google-antigravity-1.2.0"
find "$TMP/bad-quarantine" -maxdepth 1 -type d -name 'google.google-antigravity-9.9.9.*' | grep -q .
find "$TMP/bad-quarantine" -maxdepth 1 -type d -name 'google.google-antigravity-1.2.0.*' | grep -q .
/usr/bin/node -e '
  const entries = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (entries.some((entry) => entry.version === "9.9.9")) process.exit(1);
  if (entries.some((entry) => entry.version === "1.2.0")) process.exit(1);
' "$TMP/bad-extensions/extensions.json"

mkdir -p "$TMP/corrupt-extensions/unrelated.extension-3.0.0"
cat > "$TMP/corrupt-extensions/unrelated.extension-3.0.0/package.json" <<'JSON'
{"publisher":"unrelated","name":"extension","version":"3.0.0"}
JSON
printf '%s\n' '{not valid JSON' > "$TMP/corrupt-extensions/extensions.json"
PATH="$TMP/bin:$PATH" "$ROOT/ci/sync-antigravity-extension.sh" \
  "$TMP/corrupt-extensions" "$TMP/google-antigravity-1.2.0.vsix" 1.2.0 38000 \
  "$ROOT/ci/patch-antigravity-extension.sh" "$TMP/corrupt-quarantine" 2>/dev/null
grep -Fq 'const port = 38000;' "$TMP/corrupt-extensions/google.google-antigravity-1.2.0/extension.js"
grep -Fq '{not valid JSON' "$TMP/corrupt-extensions/extensions.json.corrupt-backup"
/usr/bin/node -e '
  const entries = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(entries)) process.exit(1);
  if (!entries.some((entry) => entry.identifier.id === "unrelated.extension" && entry.version === "3.0.0")) process.exit(1);
  if (!entries.some((entry) => entry.identifier.id === "google.google-antigravity" && entry.version === "1.2.0")) process.exit(1);
' "$TMP/corrupt-extensions/extensions.json"

echo "Antigravity extension sync tests passed"
