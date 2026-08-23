#!/usr/bin/env bash
# Seed half of the compile-cache rematerialization proof.
#
# Unlike seed_release.sh this runs with the compile cache ENABLED. The point
# is no longer "was the closure complete" but "does the restored closure
# produce cache HITs" -- so ZCCACHE_DISABLE must stay unset, and
# SOLDR_NO_CACHE_STATES must stay unset too or soldr suppresses the very
# HIT/MISS lines this test reads.
set -euo pipefail
. /repo/tests/cook-rematerialization/wipe_caches.sh

fixture=/repo/_vender/soldr/tests/fixtures/cook-rematerialization
workspace=/workspace
artifact=/artifact

# Start from nothing: no workspace, no registry, no soldr home (which holds
# the compile cache). A seed that inherits state proves nothing.
# CARGO_HOME and the soldr home live in the container layer, not a volume, so
# a first run is cold by construction. Clean anyway and then assert it: a
# second run inside the same container would otherwise inherit a warm cache
# and the seed would measure the wrong thing. The archive volume is the only
# state meant to survive, and it is repopulated below.
rm -rf "$workspace" "${artifact:?}"/*
wipe_all_caches
mkdir -p "$workspace" "$artifact" "$CARGO_HOME" "$ZCCACHE_CACHE_DIR"
assert_caches_empty || { echo "seed refused to run against a warm cache" >&2; exit 1; }
cp -a "$fixture/." "$workspace/"
cd "$workspace"

started_ns="$(date +%s%N)"
soldr cook --release 2>&1 | tee "$artifact/seed-log.txt"
finished_ns="$(date +%s%N)"
printf '%s\n' "$(( (finished_ns - started_ns) / 1000000 ))" > "$artifact/seed-ms.txt"

# A cooked closure must carry build-script executables or Cargo re-runs them
# and calls every dependent dirty -- the soldr#2756 false-hit bug.
test -n "$(find target/release/build -type f -name 'build-script-build*' -print -quit)"

# The archive events. Three closures, each written to /artifact, which is the
# machine-scoped volume -- the drive location that outlives the container.
soldr save --cache-dir target --workspace "$workspace" \
  --out "$artifact/cook.tar.zst" --zstd-level 1 --json | tee "$artifact/save-cook.json"
soldr save --cache-dir "$CARGO_HOME/registry" \
  --out "$artifact/registry.tar.zst" --zstd-level 1 --json | tee "$artifact/save-registry.json"
soldr save --cache-dir "$ZCCACHE_CACHE_DIR" \
  --out "$artifact/zccache.tar.zst" --zstd-level 1 --json | tee "$artifact/save-zccache.json"

python3 /repo/tests/cook-rematerialization/assert_seed_cached.py "$artifact"
