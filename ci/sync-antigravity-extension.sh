#!/usr/bin/env bash
set -euo pipefail

extensions_dir="${1:?usage: sync-antigravity-extension.sh EXTENSIONS_DIR VSIX VERSION PORT PATCH_SCRIPT QUARANTINE_DIR}"
vsix="${2:?missing VSIX path}"
version="${3:?missing extension version}"
port="${4:?missing server port}"
patch_script="${5:?missing patch script}"
quarantine_dir="${6:?missing quarantine directory}"
expected_dir="$extensions_dir/google.google-antigravity-$version"
reconcile_script="$(dirname "$0")/reconcile-antigravity-metadata.js"

if [ ! -f "$vsix" ]; then
  echo "Pinned Antigravity VSIX not found: $vsix" >&2
  exit 1
fi

mkdir -p "$extensions_dir"

# Repair a corrupt registry before invoking code-server so one bad metadata
# write cannot prevent either Antigravity or the existing extensions from
# being discovered. A second pass below removes quarantined Antigravity rows.
/usr/bin/node "$reconcile_script" "$extensions_dir" "$version" "$quarantine_dir"

code-server \
  --extensions-dir "$extensions_dir" \
  --install-extension "$vsix" \
  --force >/dev/null

# VS Code can select the highest adjacent version. Move unreviewed versions
# outside its scanner, retaining a few temporary copies for recovery and
# leaving ~/.gemini user state untouched.
quarantine_extension() {
  local candidate="$1"
  local quarantine_target
  mkdir -p "$quarantine_dir"
  quarantine_target="$quarantine_dir/$(basename "$candidate").$(date +%s).$$"
  mv "$candidate" "$quarantine_target"
  echo "  → Quarantined Antigravity extension: $(basename "$candidate")"
}

for candidate in "$extensions_dir"/google.google-antigravity-*; do
  [ -d "$candidate" ] || continue
  [ "$candidate" = "$expected_dir" ] && continue
  quarantine_extension "$candidate"
done

patch_status=0
reconcile_status=0
"$patch_script" "$expected_dir" "$port" || patch_status=$?
/usr/bin/node "$reconcile_script" "$extensions_dir" "$version" "$quarantine_dir" || reconcile_status=$?

if [ "$patch_status" -ne 0 ]; then
  if [ -d "$expected_dir" ]; then
    quarantine_extension "$expected_dir"
  fi
  /usr/bin/node "$reconcile_script" "$extensions_dir" "$version" "$quarantine_dir" || reconcile_status=$?
  exit "$patch_status"
fi
if [ "$reconcile_status" -ne 0 ]; then
  exit "$reconcile_status"
fi
