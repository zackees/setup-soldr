# Changelog

## Unreleased

## v0.9.22 - 2026-05-31

- Pre-compress race probe in the cook-cache save path (#268 Fix A,
  #274). Before invoking the expensive `--zstd-level 19` compress,
  probe the GitHub Actions cache for an existing entry at the exact
  key via `cache.restoreCache(paths, key, [], { lookupOnly: true })`.
  When a sibling job already won the race, bail out with
  `status=skipped-race-precheck` — turning the 19-minute waste
  pattern (zccache PR #480: 19m 5s compress lost the race + silently
  discarded) into a ~100-1000ms probe. This is the dominant fix for
  the wall-clock failure mode #272 made visible. Both
  `saveCookCache` (legacy) and `saveLayeredCookCache` (`soldr save
  --zstd-level 19`) paths patched. Probe failure is non-fatal —
  falls through to legacy compress+save; #272's visibility warning
  remains as the safety net.

## v0.9.21 - 2026-05-31

- Implicit `cargo-registry-cache=true` pairing when `prebuild-deps: soldr-cook`
  is set without an explicit `cargo-registry-cache` value (#267, #271).
  Without the pairing, cook restored `target/` but `$CARGO_HOME/registry`
  stayed cold — cargo then re-downloaded every `.crate` source on the next
  build (the "cook is on, why is it still downloading?" trap caught on
  zccache CI). Explicit user values + `cache-preset: minimal/foundation`
  presets (which explicitly set `cargo-registry-cache: false`) still win.
  A one-line log line announces the pairing so consumers see what happened.
- Cook-cache race-loss after a long compress is now LOUD (#268 Fix B,
  #272). When `actions/cache.saveCache` returns id<=0 (race lost) AND the
  preceding compress burned >=30s, emit a top-level `core.warning(...)`
  naming the wasted seconds + archive size + cache key. Previously this
  was a single mid-log line operators had to scroll to find; now it
  surfaces in the GitHub Actions annotations panel. Trigger case was
  zccache PR #480 (19m 5s compress → race loss → silent skip). Fix A
  (reserve key BEFORE compressing — the real ~19m→10s improvement)
  remains tracked at #268.

## v0.9.20 - 2026-05-30

- Default to soldr `0.7.47`, which lands:
  - zackees/soldr#581 — parallel per-file extraction in `soldr load`
    (the foundation for the Windows cargo-registry-cache wall-clock
    fix; bottleneck was Defender's per-CreateFile scan + NTFS MFT/USN
    overhead serialized on a single tar-extract thread).
  - zackees/soldr#583 — new `--profile-extract` flag (also
    `SOLDR_PROFILE_EXTRACT=1`) that emits per-worker job counts +
    per-file extract latency percentiles for tuning; `--auto-defender-exclude`
    CLI placeholder on Windows (real `Add-MpPreference` lifecycle is a
    follow-up that needs an internal module-graph cleanup).
  - zackees/soldr#591 — fix: per-worker `chmod` restores the Unix +x
    bit on cache-file restore, so cargo `build-script-build` binaries
    round-tripped through `soldr save`/`load` are still executable
    (regression from #581 — `std::fs::write` doesn't carry the tar
    header's mode the way `entry.unpack()` did).
- Restore-side wire-in for `soldr load` in the cargo-registry-cache
  restore path. New `src/lib/soldr-load-shim.ts` detects soldr-format
  archives (sniffs first tar entry for `SOLDR_MANIFEST.pb`) and
  branches to `soldr load --archive X --cache-dir Y` when the
  installed soldr is ≥ `0.7.46` and the archive matches. Otherwise
  falls through unconditionally to the existing tar+zstd path — no
  signature churn on `decompressCache`; the other four layers
  (build, target, cook, mini) keep their existing path. The wire-in
  is currently dormant for setup-soldr-produced archives (still tar
  format on the save side); save-side switch tracked at #263 — once
  that lands, the Windows cargo-registry-cache restore wall-clock
  drops from ~50 s to a target of < 25 s. (#260, #261, #262)

## v0.9.19 - 2026-05-30

- Default to soldr `0.7.45`, which bundles zccache `1.11.7` carrying the
  depgraph drift-detection fix (zackees/zccache#449 → PR #450): prevents
  stale-artifact hits that produced undefined-symbol link errors when
  transitive `.cpp.hpp` headers were modified in C++ unity builds.

## v0.9.18 - 2026-05-30

- Add `target-cache-save-min-compiles` (default `1`) — delta-aware save gate
  for the Rust target/ artifact cache, mirroring `build-cache-save-min-compiles`.
  When `target-cache` is opted in and the cache was restored from a fallback
  key, target-cache save is now skipped if the session compiled fewer than
  N new units; the restored entry already holds everything, so re-saving
  under a new key would just re-upload a duplicate multi-GiB payload. Closes
  the residual #214 follow-up for opt-in target-cache consumers. (#255)

## v0.9.17 - 2026-05-29

- Add the `cache-preset` umbrella input (`minimal` | `foundation` | `full`)
  that fills any cache-affecting input the consumer leaves unset; explicit
  fine-grained inputs always win over the preset. `foundation` matches the
  current historical default (no behavior change); `minimal` is the cook-only,
  no-zccache-state shape; `full` opts every layer in. The resolved preset is
  surfaced via the new `cache-preset-effective` output. (#251)
- Standardize `build-cache-mode: thin` as the resolved default when
  `target-cache` is opted in (either explicitly or via `cache-preset: full`)
  and `build-cache-mode` is unset. The heavier `once` rust-plan bundle and the
  unbounded `full` whole-target restore remain available as explicit opt-ins.
  When `target-cache` is off, the resolved mode stays `once` to preserve the
  env-visible `SETUP_SOLDR_BUILD_CACHE_MODE` value for downstream tools.
  Existing workflows with `target-cache: true` but no explicit
  `build-cache-mode` see a shape change (`once` → `thin`); keep `once` by
  setting it explicitly. (#251)
- Add `enabled: boolean` to `BuildCachePlan` so the build-cache layer's
  resolved on/off state is observable alongside `TargetCachePlan.enabled` and
  `CargoRegistryCachePlan.enabled`. (#251)

## v0.9.16 - 2026-05-29

- Default to soldr `0.7.44`, which carries the `soldr cook` project-restore fix
  (zackees/soldr#566): `cargo chef cook` no longer leaves the workspace in its
  stubbed `0.0.1` skeleton state, so builds after the cook prebuild compile real
  source at the real version. This stabilizes first-party compile-cache keys
  across cold→warm runs (the residual first-party warm-miss in #236 / #448 /
  zccache#448).

## v0.9.15 - 2026-05-29

- Fix the `[compile_journal]` diagnostic (emitted with `logging: true`) to find
  the per-invocation journal under soldr's private daemon session layout
  (`<cache>/private/<id>/logs/last-session.jsonl`) instead of only the bare
  `<cache>/logs/` path. The warm-miss dump (miss-reason histogram,
  `slowest_misses`, rollups) was previously silently empty by default. (#247)

## v0.9.14 - 2026-05-28

- Warn when `soldr cook` ran or restored but the compile-cache session reused
  none of it (`hits == 0 && misses > 0`) — the profile/toolchain/emit-kind
  mismatch fingerprint — naming the likely fix (`prebuild-deps-flags: ""`).
  (#235)
- Add the opt-in `verify-compile-cache` guard (`off`/`warn`/`error`): flag or
  fail a job that is expected to exercise zccache but reports
  `hits + misses == 0`, with bypass diagnostics (RUSTC_WRAPPER, SOLDR_CACHE_DIR,
  ZCCACHE_CACHE_DIR, shims) and a new `compile-cache-verification` output.
  Legitimate passthrough / build-cache-off / no-compile jobs are skipped. (#227)
- Add delta-aware build-cache save gating (`build-cache-save-min-compiles`,
  default `1`): skip re-saving a restored cache when nothing new compiled so a
  fallback-key hit does not re-upload a duplicate multi-GiB payload. Log
  per-phase save timing (compress vs upload) for slow-Windows-post diagnosis.
  (#230, #214)
- Add `seed-isolated-build-cache`: pre-seed an isolated `SOLDR_CACHE_DIR` with
  the content-addressed zccache artifact store (no logs/sockets/live daemon
  state) so daemon-isolated coverage/integration self-test phases start warm.
  (#240)
- Make the build-cache payload allow/deny file-class contract explicit and
  tested; preserve compiler stdout/stderr replay metadata stored inside zccache
  artifacts dirs while trimming standalone diagnostics. (#229)
- Harden the cache-mode benchmark: zccache hit/miss/compile columns on cook
  warm rows, an in-script per-cell timeout with a timeout row and
  still-running-child capture, a p95 aggregate, and a `reps=3` preset.
  (#192, #191)
- Document the per-layer cache policy defaults (default-on/off/opt-in), a
  pre-trim migration path, the Windows cargo-registry restore cost, the cook
  profile/toolchain/emit axes, and a cache-inspection guide. (#193, #231, #232)

## v0.9.13 - 2026-05-28

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
