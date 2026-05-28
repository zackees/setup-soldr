# Changelog

## Unreleased

- Default to soldr `0.7.43`, copy the bundled `cargo-chef` binary from soldr
  release archives, and export `SOLDR_CARGO_CHEF_LOCAL_DIR` so `soldr cook`
  does not perform a live cargo-chef release lookup.
- Move the main and cleanup actions to the Node 24 GitHub Actions runtime.
- Add opt-in `dylint-cache` support for caching `cargo-dylint`, `dylint-link`,
  and compatible Dylint driver directories.
- Resolve final zccache stats from private session and archived shutdown logs.

## v0.9.12 - 2026-05-28

- Trim the default cache footprint: keep the Soldr/zccache build-cache enabled,
  but default the optional target-cache and cargo-registry-cache layers off.
- Add a zccache build-cache payload profile that skips
  `zccache/private/*/artifacts/**`, zccache log subtrees, and loose diagnostic
  files before tar/zstd saves.
- Add top-subtree payload audit output so oversized cache entries identify the
  largest contributing subtrees, not only individual files.
- Lower the default tar-backed cache payload warning threshold to `512MiB`
  while keeping the `2GiB` hard skip cap.

## v0.9.11 - 2026-05-28

- Add the cleanup sub-action for workflows that need to quiesce soldr/zccache
  before post-job cache saves.
- Formalize `prebuild-deps: soldr-cook`, including layered cook cache support
  for soldr `0.7.38+`.
- Harden the real-cache benchmark workflow so warm/cold setup-soldr paths use
  real GitHub cache actions and stable cook-production shaping.
- Default to soldr `0.7.42`, and seed zccache from the zccache trio bundled
  inside soldr release archives before using the legacy cross-repo zccache
  release fallback.
- Seed soldr's pinned zccache install during setup so isolated `SOLDR_CACHE_DIR`
  test roots do not refetch zccache or fall back to `cargo install`.
- Run that seed even when `build-cache` is disabled, and add
  `zccache-seed-strict` so repos can fail setup if zccache cannot be pinned
  instead of allowing a later slow `cargo install` fallback.
- Default `cache-payload-max-bytes` to `2GiB` with `skip` behavior to avoid
  uploading runaway multi-GiB zccache artifact caches in normal CI.

## v0.9.10 - 2026-05-26

- Fixed cache-mode benchmark methodology so the matrix now measures distinct
  build-affecting layers instead of reusing warmed target or zccache state.
- Added runner-image delta measurement for the solo-toolchain benchmark path.
- Verified the repaired default benchmark run:
  <https://github.com/zackees/setup-soldr/actions/runs/26457448768>.
