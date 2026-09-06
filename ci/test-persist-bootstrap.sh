#!/bin/bash
# Guards the persistence bootstrap in railway-entrypoint.sh.
#
# The bootstrap decides where home state lives. Getting it wrong is silent:
# the container starts fine and the loss only shows up on the next redeploy,
# when extensions, logins and the workspace are gone. So it gets a test.
#
# Runs entirely in a temp directory. Touches nothing real.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRYPOINT="$ROOT/railway-entrypoint.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Extract the bootstrap block: from its banner to the second closing "fi".
awk '/PERSISTENCE BOOTSTRAP/{f=1} f{print} f&&/^    fi$/{n++; if(n==2) exit}' \
    "$ENTRYPOINT" | sed 's/^    //' > "$TMP/block.sh"

if [ ! -s "$TMP/block.sh" ]; then
    echo "FAIL: persistence bootstrap not found in railway-entrypoint.sh"
    exit 1
fi

cat > "$TMP/run.sh" <<'RUNNER'
export CLAUDER_HOME PERSIST_ROOT CLAUDER_UID CLAUDER_GID
source "$BLOCK"
RUNNER

fail=0

# Explicit PERSIST_ROOT, no Railway variable in sight.
run() {
    env -u RAILWAY_VOLUME_MOUNT_PATH \
        CLAUDER_HOME="$1" PERSIST_ROOT="$2" \
        CLAUDER_UID="$(id -u)" CLAUDER_GID="$(id -g)" \
        BLOCK="$TMP/block.sh" bash "$TMP/run.sh" >/dev/null 2>&1
}

# No PERSIST_ROOT: the location has to be worked out from the Railway variable.
run_auto() {
    env -u PERSIST_ROOT \
        CLAUDER_HOME="$1" RAILWAY_VOLUME_MOUNT_PATH="$2" \
        CLAUDER_UID="$(id -u)" CLAUDER_GID="$(id -g)" \
        BLOCK="$TMP/block.sh" bash "$TMP/run.sh" >/dev/null 2>&1
}

ck() {
    if [ "$2" = "$3" ]; then
        echo "  ok    $1"
    else
        echo "  FAIL  $1: expected [$3], got [$2]"
        fail=1
    fi
}

echo "1. first boot: home has content, volume is empty"
mkdir -p "$TMP/h/workspace" "$TMP/h/.claude" "$TMP/v"
echo from-home > "$TMP/h/workspace/file.txt"
echo cfg > "$TMP/h/.claude.json"
run "$TMP/h" "$TMP/v"
ck "workspace became a link"  "$([ -L "$TMP/h/workspace" ] && echo yes || echo no)" "yes"
ck "content moved to volume"  "$(cat "$TMP/v/workspace/file.txt" 2>/dev/null)" "from-home"
ck "readable through link"    "$(cat "$TMP/h/workspace/file.txt" 2>/dev/null)" "from-home"
ck ".claude.json on volume"   "$(cat "$TMP/v/.claude.json" 2>/dev/null)" "cfg"

echo "2. redeploy: home is fresh, volume has content - volume wins"
rm -rf "$TMP/h"; mkdir -p "$TMP/h/workspace" "$TMP/h/.claude"
run "$TMP/h" "$TMP/v"
ck "work survived redeploy"   "$(cat "$TMP/h/workspace/file.txt" 2>/dev/null)" "from-home"
ck "settings came back"       "$(cat "$TMP/h/.claude.json" 2>/dev/null)" "cfg"

echo "3. running twice in a row changes nothing"
run "$TMP/h" "$TMP/v"
ck "idempotent"               "$(cat "$TMP/h/workspace/file.txt" 2>/dev/null)" "from-home"
ck "link not nested"          "$([ -L "$TMP/h/workspace" ] && echo yes || echo no)" "yes"

echo "4. no volume: home is left alone"
mkdir -p "$TMP/h2/workspace"; echo local > "$TMP/h2/workspace/file.txt"
run "$TMP/h2" ""
ck "home stayed a directory"  "$([ -L "$TMP/h2/workspace" ] && echo link || echo dir)" "dir"
ck "file untouched"           "$(cat "$TMP/h2/workspace/file.txt" 2>/dev/null)" "local"

echo "5. volume location is worked out from the Railway variable"
mkdir -p "$TMP/h3/workspace" "$TMP/v3"
echo auto > "$TMP/h3/workspace/file.txt"
run_auto "$TMP/h3" "$TMP/v3"
ck "picked <volume>/clauder-home" "$(cat "$TMP/v3/clauder-home/workspace/file.txt" 2>/dev/null)" "auto"
ck "home became a link"           "$([ -L "$TMP/h3/workspace" ] && echo yes || echo no)" "yes"

echo "6. volume already mounted at home: stay out of the way"
mkdir -p "$TMP/h4/workspace"; echo self > "$TMP/h4/workspace/file.txt"
run_auto "$TMP/h4" "$TMP/h4"
ck "home stayed a directory"  "$([ -L "$TMP/h4/workspace" ] && echo link || echo dir)" "dir"
ck "file untouched"           "$(cat "$TMP/h4/workspace/file.txt" 2>/dev/null)" "self"

echo
if [ $fail -eq 0 ]; then
    echo "ALL CHECKS PASSED"
else
    echo "FAILURES ABOVE"
fi
exit $fail
