#!/usr/bin/env bash
set -euo pipefail

main() {
  cd "$(dirname "$0")/../.."
  bats ./test/scripts
  ./ci/test-persist-bootstrap.sh
}

main "$@"
