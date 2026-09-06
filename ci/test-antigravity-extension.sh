#!/usr/bin/env bash
# Verifies that the cloud image installs the exact reviewed Antigravity VSIX.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$ROOT/Dockerfile"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

version="$(sed -n 's/^ARG ANTIGRAVITY_EXTENSION_VERSION=//p' "$DOCKERFILE")"
expected_sha="$(sed -n 's/^ARG ANTIGRAVITY_EXTENSION_SHA256=//p' "$DOCKERFILE")"

if [[ -z "$version" || -z "$expected_sha" ]]; then
  echo "Antigravity version or checksum is missing from Dockerfile" >&2
  exit 1
fi

if grep -q 'google-antigravity/latest/vspackage' "$DOCKERFILE"; then
  echo "Dockerfile must pin an Antigravity release instead of using latest" >&2
  exit 1
fi

if grep -Eq '^EXPOSE .*38000' "$DOCKERFILE"; then
  echo "The Antigravity hub port must not be published by the container image" >&2
  exit 1
fi

# shellcheck disable=SC2016
if ! grep -Fq 'ENV ANTIGRAVITY_EXTENSION_VERSION=${ANTIGRAVITY_EXTENSION_VERSION}' "$DOCKERFILE"; then
  echo "Runtime Antigravity version must come from the pinned Docker build argument" >&2
  exit 1
fi
if grep -Fq 'ANTIGRAVITY_EXTENSION_VERSION:-1.2.0' "$ROOT/railway-entrypoint.sh"; then
  echo "Entrypoint must not duplicate the pinned Antigravity version" >&2
  exit 1
fi
# shellcheck disable=SC2016
if ! grep -Fq 'if [ -z "${ANTIGRAVITY_EXTENSION_VERSION:-}" ]; then' "$ROOT/railway-entrypoint.sh"; then
  echo "Entrypoint must keep the base IDE available when Antigravity version metadata is missing" >&2
  exit 1
fi

vsix="$TMP/google-antigravity.vsix"
url="https://marketplace.visualstudio.com/_apis/public/gallery/publishers/Google/vsextensions/google-antigravity/${version}/vspackage"

curl --compressed --fail --silent --show-error --location --retry 3 \
  "$url" --output "$vsix"
echo "$expected_sha  $vsix" | sha256sum -c

package_version="$(unzip -p "$vsix" extension/package.json | jq -r .version)"
if [[ "$package_version" != "$version" ]]; then
  echo "VSIX version $package_version does not match pinned version $version" >&2
  exit 1
fi

if ! unzip -p "$vsix" extension.vsixmanifest | \
  grep 'Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"' >/dev/null; then
  echo "Antigravity must remain a server-side workspace extension" >&2
  exit 1
fi

mkdir -p "$TMP/unpacked"
unzip -q "$vsix" extension/extension.js -d "$TMP/unpacked"
# shellcheck disable=SC2016
if ! grep -Fq 'const backendUrl = `http://127.0.0.1:${port}`;' "$TMP/unpacked/extension/extension.js"; then
  echo "Antigravity extension no longer targets its hub through loopback" >&2
  exit 1
fi
"$ROOT/ci/patch-antigravity-extension.sh" "$TMP/unpacked/extension" 38000
"$ROOT/ci/patch-antigravity-extension.sh" "$TMP/unpacked/extension" 38000
grep -Fq 'const port = 38000;' "$TMP/unpacked/extension/extension.js"

if ! command -v code-server >/dev/null 2>&1; then
  echo "code-server is required for the Antigravity install and registry checks" >&2
  exit 1
fi

mkdir -p "$TMP/extensions" "$TMP/user-data"
env -u CODE_SERVER_PARENT_PID \
  -u CODE_SERVER_SESSION_SOCKET \
  -u VSCODE_IPC_HOOK_CLI \
  code-server \
  --extensions-dir "$TMP/extensions" \
  --user-data-dir "$TMP/user-data" \
  --install-extension "$vsix" \
  --force >/dev/null

extension_dir="$TMP/extensions/google.google-antigravity-${version}"
installed_manifest="$extension_dir/package.json"
if [[ ! -f "$installed_manifest" ]]; then
  echo "code-server accepted the VSIX but did not install Antigravity" >&2
  exit 1
fi
"$ROOT/ci/patch-antigravity-extension.sh" "$extension_dir" 38000
grep -Fq 'const port = 38000;' "$extension_dir/extension.js"

probe_dir="$TMP/extensions/test.registry-probe-1.0.0"
mkdir -p "$probe_dir"
cat > "$probe_dir/package.json" <<'JSON'
{"name":"registry-probe","displayName":"Registry Probe","publisher":"test","version":"1.0.0","engines":{"vscode":"*"}}
JSON
printf '%s\n' '{corrupt registry' > "$TMP/extensions/extensions.json"
/usr/bin/node "$ROOT/ci/reconcile-antigravity-metadata.js" "$TMP/extensions" "$version" "$TMP/quarantine" 2>/dev/null
jq -e '
    all(.[].location; .scheme == "file" and (.path | type == "string")) and
    all(.[].metadata; type == "object") and
    any(.[]; .identifier.id == "test.registry-probe" and .version == "1.0.0") and
    any(.[]; .identifier.id == "google.google-antigravity" and .version == $version)
  ' --arg version "$version" "$TMP/extensions/extensions.json" >/dev/null
listed_extensions="$(env -u CODE_SERVER_PARENT_PID \
  -u CODE_SERVER_SESSION_SOCKET \
  -u VSCODE_IPC_HOOK_CLI \
  code-server --extensions-dir "$TMP/extensions" --user-data-dir "$TMP/user-data" --list-extensions --show-versions)"
grep -Fq 'test.registry-probe@1.0.0' <<<"$listed_extensions"
grep -Fq "google.google-antigravity@$version" <<<"$listed_extensions"

echo "Antigravity VSIX $version verified"
