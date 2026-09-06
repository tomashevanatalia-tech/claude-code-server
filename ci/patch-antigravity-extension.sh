#!/usr/bin/env bash
set -euo pipefail

extension_dir="${1:?usage: patch-antigravity-extension.sh EXTENSION_DIR [PORT]}"
port="${2:-38000}"
extension_js="$extension_dir/extension.js"

case "$port" in
  "" | *[!0-9]* | ??????*)
    echo "Invalid Antigravity port: expected an integer from 1024 to 65535" >&2
    exit 1
    ;;
esac
port=$((10#$port))
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
  echo "Invalid Antigravity port: expected an integer from 1024 to 65535" >&2
  exit 1
fi

if [ ! -f "$extension_js" ]; then
  echo "Antigravity extension entrypoint not found: $extension_js" >&2
  exit 1
fi

original='const port = Number(configuredPort) || (await this.getAvailableEphemeralPort());'
marker='/* code-server-antigravity-fixed-port */'
patched="const port = $port; $marker"

if grep -Fq "$patched" "$extension_js"; then
  exit 0
fi
count_occurrences() {
  awk -v needle="$1" '
    {
      line = $0
      while ((position = index(line, needle)) > 0) {
        count++
        line = substr(line, position + length(needle))
      }
    }
    END { print count + 0 }
  ' "$extension_js"
}

original_count="$(count_occurrences "$original")"
marker_count="$(count_occurrences "$marker")"
temporary="$(mktemp "$extension_dir/.antigravity-patch.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
if [ "$original_count" -eq 1 ] && [ "$marker_count" -eq 0 ]; then
  awk -v needle="$original" -v replacement="$patched" '
    {
      position = index($0, needle)
      if (position > 0) {
        $0 = substr($0, 1, position - 1) replacement substr($0, position + length(needle))
      }
      print
    }
  ' "$extension_js" > "$temporary"
elif [ "$original_count" -eq 0 ] && [ "$marker_count" -eq 1 ]; then
  awk -v replacement="$patched" '
    {
      if (match($0, /const port = [0-9]+; \/\* code-server-antigravity-fixed-port \*\//)) {
        $0 = substr($0, 1, RSTART - 1) replacement substr($0, RSTART + RLENGTH)
      }
      print
    }
  ' "$extension_js" > "$temporary"
else
  echo "Pinned Antigravity extension no longer contains the reviewed server-port hook" >&2
  exit 1
fi
extension_mode="$(stat -c '%a' "$extension_js")"
chmod "$extension_mode" "$temporary"
mv "$temporary" "$extension_js"
trap - EXIT

[ "$(count_occurrences "$patched")" -eq 1 ]
[ "$(count_occurrences "$original")" -eq 0 ]
