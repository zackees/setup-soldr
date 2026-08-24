#!/usr/bin/env bash
# Blow away every location a compile cache could survive in.
#
# Sourced, not executed. Relying on ZCCACHE_DISABLE alone to keep a build
# uncached is a single point of failure: if the flag is ever renamed,
# re-scoped, or silently ignored, a test that assumed it worked keeps passing
# while measuring something else entirely. Removing the state too means the
# flag and the wipe would both have to fail together.
wipe_all_caches() {
  local dir
  for dir in \
    "${ZCCACHE_CACHE_DIR:-}" \
    "${SOLDR_MANAGED_ZCCACHE_CACHE_DIR:-}" \
    "${SOLDR_TARGET_CACHE_DIR:-}" \
    "${SOLDR_CACHE_DIR:-}" \
    "${SOLDR_HOME:-}" \
    /root/.soldr \
    /root/.cache/zccache \
    /root/.zccache \
    /root/.cache/sccache \
    "${CARGO_HOME:-/root/.cargo}/registry" \
    "${CARGO_HOME:-/root/.cargo}/git"
  do
    [ -n "$dir" ] || continue
    # Empty the directory rather than removing it: several are container
    # volume mount points, and removing a mount point either fails or
    # detaches the volume the next step expects to write into.
    if [ -d "$dir" ]; then
      find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
    fi
  done
}

# Fail loudly if anything survived where a compile cache would live.
assert_caches_empty() {
  local dir residue=0
  for dir in "${ZCCACHE_CACHE_DIR:-}" /root/.soldr "${CARGO_HOME:-/root/.cargo}/registry"; do
    [ -n "$dir" ] || continue
    # Check for FILES, not entries. The caller recreates the empty cache
    # directory after wiping (soldr needs it to exist), so an empty directory
    # tree is expected; a single surviving file is not.
    if [ -d "$dir" ] && [ -n "$(find "$dir" -type f -print -quit 2>/dev/null)" ]; then
      echo "cached content survived the wipe: $dir" >&2
      find "$dir" -type f 2>/dev/null | head -20 >&2
      residue=1
    fi
  done
  return "$residue"
}
