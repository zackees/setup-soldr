#!/usr/bin/env bash
# Warm half of the compile-cache rematerialization proof.
#
# Wipes the soldr home (compile cache included), the registry and the
# workspace, restores all three from the archives the seed wrote to
# /artifact, then builds with the cache ENABLED and asserts that no
# third-party crate compiles with a MISS.
set -euo pipefail
. /repo/tests/cook-rematerialization/wipe_caches.sh

fixture=/repo/_vender/soldr/tests/fixtures/cook-rematerialization
workspace=/workspace
artifact=/artifact

# Start over with the cache. This container is a different Bosn stack with its
# own cargo-home and soldr-home volumes, but wipe anyway so the proof does not
# depend on that isolation holding.
rm -rf "$workspace"
wipe_all_caches
mkdir -p "$workspace" "$CARGO_HOME" "$ZCCACHE_CACHE_DIR"
cp -a "$fixture/." "$workspace/"
cd "$workspace"

# Prove the wipe actually happened before restoring over it. Without this the
# whole proof is circular: a surviving cache would produce the HITs the test
# is trying to attribute to the restored archive.
assert_caches_empty || { echo "refusing to verify against a surviving cache" >&2; exit 1; }

soldr hydrate --archive "$artifact/registry.tar.zst" --cache-dir "$CARGO_HOME/registry" --json
soldr hydrate --archive "$artifact/zccache.tar.zst" --cache-dir "$ZCCACHE_CACHE_DIR" --json
soldr hydrate --archive "$artifact/cook.tar.zst" --cache-dir target --workspace "$workspace" --json

test -n "$(find target/release/build -type f -name 'build-script-build*' -print -quit)"

started_ns="$(date +%s%N)"
soldr cargo build --release --locked -vv \
  --message-format=json-render-diagnostics \
  > "$artifact/warm-messages.jsonl" \
  2> "$artifact/warm-stderr.log"
finished_ns="$(date +%s%N)"
printf '%s\n' "$(( (finished_ns - started_ns) / 1000000 ))" > "$artifact/warm-ms.txt"

# The build must actually produce a working binary; a cache proof over a
# broken artifact is worthless.
test "$(target/release/cook-rematerialization-fixture)" = '{"value":42}'

python3 /repo/tests/cook-rematerialization/assert_cache_hits.py \
  "$artifact/warm-messages.jsonl" \
  "$artifact/warm-stderr.log" \
  "$artifact/warm-report.json"
