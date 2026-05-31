# Changelog

## Unreleased

## v0.9.31 - 2026-05-31

- Parallel cook-cache base + delta restore (closes #295 Fix B, #296).
  The previous serial `await base; if (base.matchedKey) await delta`
  shape wasted ~11s of wall clock per warm run for zero correctness
  benefit — the delta key is independently computed (includes
  everything the base key does + source/git fingerprint), so the two
  restores have no data dependency. Now run via `Promise.all([base,
  delta])`. Contract preserved: when base missed, the delta archive
  is semantically invalid and discarded so callers can rely on
  `base.matchedKey === "" ⇒ delta.hit === false`. Validation rerun
  for #621 showed cook-cache-delta MISS taking 11.2s wall clock
  because it was waiting on base; this fix should shave that ~11s
  off the parallel-restore phase on warm runs.

## v0.9.30 - 2026-05-31

- Default to soldr `0.7.51`, which lands `soldr cook` warm-skip
  (zackees/soldr#622, closes zackees/soldr#621). When the recipe
  + rustc + soldr version match a previously-written marker file
  in `target/`, soldr cook short-circuits Phase 2 (the cargo-chef
  orchestration walk) — saving ~5 min on Coverage-shape workloads
  and ~2.5 min on Integration-shape ones, with no behavior change
  for cold runs or any case where the marker doesn't match.
  Marker is schema-versioned, per-target-dir, and falls through
  to the normal cook path on any read failure / mismatch / missing
  file. README + action.yml default version bumped to 0.7.51.

## v0.9.29 - 2026-05-31

- Post-step save table now includes build-cache + cargo-registry
  rows in ALL outcomes (#291). #287 patched 4 sites (solo-toolchain,
  cook-cache layered/legacy, soldr-mini) but build-cache and
  cargo-registry use a different code path that was missed — they
  only recorded `saved` / `oversize-skip`, filtering out
  `tiny-delta-skip` / `exact-hit-skip` / etc. Result: post-step
  table showed only the cook layer on common runs where build-cache
  was an exact hit. Now every layer renders regardless of outcome.

## v0.9.28 - 2026-05-31

- One-line setup-phase summary at end of pre-build (#289, #283
  companion). Reads the SETUP_SOLDR_PHASE_*_START_MS env vars
  (already recorded by `markPhase`) and emits a one-line aggregate
  showing each phase's wall-clock delta:

      setup phase totals: resolve=8.5s parallel-restore=8.9s
        target-tree=0.0s toolchain=8.9s install=2.2s zccache-seed=0.1s
        verify=0.1s cross-bootstrap=0.0s cook=152.4s total=181.0s

  Previously, identifying which pre-build phase consumed which slice
  of the budget required raw env-var inspection. The aggregate makes
  pre-build regressions visible on the first read — same shape as
  the post-step `cache save totals:` line. Phases whose env var
  isn't set (passthrough mode, test harness) are silently skipped.

## v0.9.27 - 2026-05-31

- Record skipped save layers in the post-step save table (#287). The
  v0.9.26 table from #285 only showed `status=saved` rows because
  `postCollector.record()` was gated saved-only; skip cases (race-
  precheck, tiny-delta, oversize, exact-hit, missing-target) just
  emitted single-line logs. Now every save attempt records into the
  StatsCollector, so the table renders every layer with its actual
  status. archive/inflated/file totals still only count what
  actually uploaded.

  Why the skip-decisions matter as their own row: `cook-cache
  skipped-race-precheck 0.1s` confirms #268 Fix A is firing;
  `build-cache skipped tiny-delta 0.3s` confirms the save-min-compiles
  gate is doing its job; `build-cache skipped oversize` flags that
  `cache-payload-max-bytes` (default 6GiB since v0.9.24) may need
  raising for this workload.

## v0.9.26 - 2026-05-31

- Per-layer cache-save table alongside the one-line aggregate
  (closes #269, #285). Mirrors the restore-side `summaryText()`
  shape: one row per save op with label, status, archive bytes,
  file count, wall-clock. Footer rolls up the totals.

  ```
  cache                 save status              archive    files     time
  ──────────────────────────────────────────────────────────────────────────
  build-cache           saved                     1.19 GB   24284    15.6s
  cargo-registry-cache  saved                    56.1 MB     3142     6.4s
  cook-cache-base       skipped-race-precheck     0 B          -      0.1s
  soldr-mini-cache      exact-hit-skip            0 B          -      0.0s
  ──────────────────────────────────────────────────────────────────────────
  2/4 saved  total upload: 1.25 GB  total wall: 22.1s
  ```

  Logged in sequence with the v0.9.25 one-liner — table first
  (detail), one-liner second (skim-readable). Empty when zero save
  ops recorded. Pure-formatting addition; no behavior change.

## v0.9.25 - 2026-05-31

- One-line cache-save aggregate at end of post step (#269 minimal cut,
  #283). After the existing per-layer `final cache summary:` line,
  log a rolled-up budget view:

      cache save totals: layers_saved=2/4 uploaded=1.25GB total_ms=24500

  Pulls from existing `StatsCollector` op records — no new
  instrumentation. Empty (no log line) when zero save ops were
  recorded. Designed to surface post-step budget regressions on the
  first run, not after manually scrolling per-layer records.

## v0.9.24 - 2026-05-31

- Raise `cache-payload-max-bytes` default 2GiB → 6GiB (#279, #280).
  The 2GiB cap was leaving the build-cache layer chronically inert on
  medium-large Rust workspaces. zccache CI itself ran 4-5 GiB / skip
  every run with the previous default — `build-cache: true` enabled the
  layer, but the save side never fired, wasting the cold-restore lookup
  + post-step census walk for zero value. 6GiB matches realistic zccache
  footprint for medium-large workspaces AND sits comfortably below
  GitHub Actions' ~10 GiB per-entry / per-repo budget. Runaway producers
  (7+ GiB single save) still trip the guardrail. action.yml + README
  only — no source/dist changes.

## v0.9.23 - 2026-05-31

- Default to soldr `0.7.48`, which bundles zccache `1.11.8` carrying the
  cross-clone cache-pollution fix (zackees/zccache#474 → PR #478): per-worktree
  key for PCH + MSVC plus explicit triple prefix-map
  (`-ffile-prefix-map` + `-fmacro-prefix-map` + `-fdebug-prefix-map`) for
  clang/gcc. Without 1.11.8, `.obj` artifacts produced in worktree A leaked
  into worktree B with original-clone absolute paths still embedded,
  breaking downstream PCH builds with header-redefinition errors.
- README + `action.yml` default version both bumped to 0.7.48.
- Hotfix #277: ncc side-chunk files (`<id>.index.js`) produced by ANY
  dynamic `await import(...)` — including transitive imports inside
  `@actions/artifact` → `@azure/identity` — are now COPIED alongside
  `dist/post.js` (and `dist/main.js`, `cleanup/dist/index.js`). v0.9.22
  shipped without those chunks because `scripts/bundle-entrypoint.mjs`
  only copied the main bundle; the cargo-registry save path opted in via
  `SOLDR_CARGO_REGISTRY_VIA_SOLDR=1` (#265) crashed with `Cannot find
  module './84.index.js'` on zccache CI run 26698978997. Module-ID
  renumbering is now skipped when chunks are present so chunk-reference
  IDs stay in sync with on-disk filenames. Also converts our own
  `await import("./lib/soldr-load-shim.js")` to static — one fewer
  chunk to ship.

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
