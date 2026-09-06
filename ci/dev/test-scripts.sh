#!/usr/bin/env bash
set -euo pipefail

main() {
  cd "$(dirname "$0")/../.."
  bats ./test/scripts
  ./ci/test-persist-bootstrap.sh
  ./ci/test-antigravity-patch.sh
  ./ci/test-antigravity-ports.sh
  ./ci/test-antigravity-sync.sh
  node ./ci/test-antigravity-proxy.js
  node ./ci/test-antigravity-proxy-lifecycle.js
}

main "$@"
