# Changelog

## Unreleased

## v0.9.61 - 2026-06-02

- Cache-eviction now sorts evictable entries by size descending
  (biggest first) instead of age ascending (oldest first). Same
  byte-target reached with ~10× fewer API calls in production.
  Observation on zccache: a typical 1.33 GB eviction needs to
  delete only ~10 big entries (>10 MB) when sorted biggest-first;
  oldest-first sort burns API calls on ~300 tiny sccache shards
  (<1 MB each, 70% of evictable population) to free the same
  bytes. Age remains the tiebreaker when sizes match. The age-
  floor (#352/#356) still gates fresh entries so we don't
  delete just-saved entries from this run. GitHub's own LRU
  evicts truly-stale tiny entries at 7-day inactivity.

## v0.9.60 - 2026-06-02

- Parallelize cache-eviction deletes with concurrency=10. Sequential
  deletes were observed at ~190ms each on the GitHub Actions Cache
  API; large eviction passes (300+ entries on a busy repo) took ~57s
  of post-step wall-clock. Worker-pool pattern with N=10 drops that
  to ~6s. Per-CI-cycle savings: ~50s × matrix-job-count of post-step
  time on the over-budget path.
- Pre-compute eviction list before firing deletes (was: decrement
  byte counter mid-loop). Over-deletion bounded by CONCURRENCY ×
  largest-entry which is negligible vs the budget target.
- 401/403 still aborts via shared flag; up to CONCURRENCY failed
  API calls before the abort propagates (was 1). Acceptable tradeoff
  for the per-cycle wall-clock savings.

## v0.9.59 - 2026-06-02

- Drop git SHA from cargo-registry cache key (closes #371). Same
  anti-pattern fix as #237 did for build-cache. Production
  observation: every commit's cargo-registry exact-key probe was
  missing (only matched same-SHA retries), and the action would
  burn ~56 MB upload bandwidth saving a new entry that no future
  probe could hit. The restore-key prefix (without SHA) already
  did the actual work via FALLBACK. After this fix, exact-key
  hit rate per (lockHash, digest) generation should climb toward
  ~100%, save-status flips to `skipped-race` for subsequent
  matrix jobs, and per-CI-cycle redundant uploads drop by ~50 MB
  × matrix-job-count.

## v0.9.58 - 2026-06-02

- Eviction log splits foundation-protected vs age-floor-protected
  counts. After #368 added cook-base to FOUNDATION_PREFIXES, the
  legacy single `protected N entries (younger than Xh)` line
  conflated entries skipped for being foundation (any age) with
  entries skipped for being too fresh. Operators couldn't tell
  whether the eviction was finding nothing because the budget was
  healthy or because foundation entries crowded everything else
  out. New format: `protected F entries by foundation prefix
  (#368), A entries by age floor (younger than Xh, #352/#356),
  E entries evictable`.

## v0.9.57 - 2026-06-02

- Add `cook-base-v2-` to `FOUNDATION_PREFIXES` so our controlled
  eviction skips cook-cache-base entries (closes #368). Production
  observation on zccache: a base entry that HIT at 08:17 was GONE
  by 08:38 on a 20-minute child commit cycle — graduated age floor
  (0.5h danger / 2h moderate / 6h baseline) doesn't protect entries
  older than 6h, and cook-base saves typically live for many hours.
  Cost of MISS = ~200s of cold cook; size = ~300 MB / platform
  after v0.9.53's zstd-9. Ratio comparable to solo-toolchain.
  GitHub's own LRU still evicts truly-stale cook-base entries that
  no run accesses for ~7 days, so unbounded growth is bounded.

## v0.9.56 - 2026-06-02

- Fix v0.9.55's parentSha derivation on shallow checkouts (the
  default `actions/checkout` config with `fetch-depth: 1`). The
  initial `git log -1 --format=%P HEAD` returns empty for the
  grafted root commit — production observation on zccache MSRV
  v0.9.55 showed `parent-sha: unexpected git output "\n"; leaving
  empty` immediately followed by `cook-cache-delta MISS`.
- New fallback: `git cat-file -p HEAD` reads the raw commit
  object whose `parent` header line is preserved even when the
  parent commit isn't fetched. This works for shallow checkouts
  and is the path most CI workflows will exercise.
- Pass 1 (`git log %P`) still runs first because it's slightly
  cheaper and works on full-depth checkouts.

## v0.9.55 - 2026-06-02

- Auto-derive `parentSha` from `git log -1 --format=%P HEAD` when
  the `ACTION_PARENT_SHA` env var isn't provided (closes #365).
  cook-cache-delta + target-cache + cargo-registry already had a
  parent-SHA fallback restore key, but it was inert in practice
  because consumers don't set `ACTION_PARENT_SHA`. Production
  observation: cook-cache-delta hit rate was 0% across 6 jobs ×
  3 zccache runs. With auto-derivation, the parent-SHA fallback
  key is populated for any repo with a non-shallow checkout
  (actions/checkout default is `fetch-depth: 1`, so consumers
  may need to bump it to enable this; falls back to "" silently
  otherwise — no regression from prior behavior).
- Add the parent fallback key to the cook-layered-keys log line
  for visibility into whether the fallback is wired up.

## v0.9.54 - 2026-06-02

- Extend #360 per-layer split timing (compress vs upload) to
  `build-cache` and `cargo-registry`. Their save paths already
  captured `CacheSavePhaseTimings` internally (from #214) but the
  postCollector record didn't surface them, so the table showed
  `-` in the new compress/upload columns for everything except
  cook-cache. With this change, build-cache and cargo-registry
  rows show the split too — operators can finally see at a
  glance whether build-cache's 5s save is dominated by compress
  or upload. target-cache uses `cache.saveCache` directly (no
  split available without internal API plumbing) and continues
  to show `-` in the new columns.

## v0.9.53 - 2026-06-01

- Lower cook-cache base compression level from zstd-19 → zstd-9.
  Cuts the post-step compress wall-clock ~4× (production
  observation on zccache: 165s for ~224 MB output) at the cost of
  ~25% larger archive (~280 MB) and ~1s extra upload wall-clock
  per save. zstd decompression speed is level-independent, so
  warm restores are unaffected. Net: ~125s win per save-attempt,
  with a much bigger multiplier on race-loss scenarios (5-way
  matrix where 1 job wins reservation and 4 lose: 660s → 160s of
  compress CPU wasted per CI cycle). Cook-cache-delta stays at
  level 3 (already cheap). Relates to #268/#358 (residual cook-
  cache double-compress race waste); this is a palliative that
  shrinks the worst-case race-loss window 4× without changing the
  reservation timing.

## v0.9.52 - 2026-06-01

- Per-layer cache metrics now split compress wall-clock from
  upload wall-clock for cook-cache saves (closes #360). The
  post-step's per-layer save table gains `compress` and `upload`
  columns when any layer reports split timing, and the footer
  totals both. Answers "is the post-step bottlenecked by CPU
  (compress) or network (upload)?" at a glance. Other layers
  (build-cache, cargo-registry, etc.) leave the new columns
  empty and use the legacy single-column layout. Schema-only
  for non-cook layers; cook-cache `CookSaveResult` gains
  optional `compressMs` + `uploadMs` fields.

## v0.9.51 - 2026-06-01

- Per-line timestamps on `soldr cook` output (closes #359). Cargo's
  `Compiling`/`Downloading`/`Updating crates.io index` lines now
  receive the same `MM:SS ` elapsed-time prefix as setup-soldr's
  own log lines, so forensic analysis of a slow cook phase can
  identify the bottleneck crate directly from the log timestamps.
  Implementation: `listeners.stdline`/`errline` on the `exec.exec`
  call for `soldr cook`, re-emitting each line through the existing
  `formatLogLine` helper. ANSI color escape sequences in cargo's
  output pass through unchanged. Honors `timestamps: false` (off
  for both setup-soldr lines and cook lines).

## v0.9.50 - 2026-06-01

- Graduated age floor for `cache-eviction-policy` (closes #356).
  v0.9.48's fixed 6h age floor became a no-op under heavy CI
  load — observed on zccache MSRV at 13.63 GB usage where ALL
  171 evictable entries were < 6h, leaving GitHub's own
  non-deterministic LRU in charge (which can evict foundation
  prefixes arbitrarily, defeating `protect-foundations`).
  New tier table relaxes the floor as overshoot grows:
  - small overshoot (<1 GB over trigger): baseline 6h —
    unchanged (#352 fix preserved).
  - moderate (1–3 GB over): 2h — protect only the current CI
    wave's saves.
  - danger (>3 GB over): 0.5h — only this run's just-saved
    entries protected; controlled eviction wins the race
    against GitHub's LRU.
  Post-step log emits `graduated age floor active — overshoot=
  X GB, floor=Y h` when relaxed. `aggressive` policy gets the
  same tiering (baseline 2h, danger 0.5h).

## v0.9.49 - 2026-06-01

- Raise `cache-eviction-policy` thresholds to better utilize
  GitHub's 10 GB repo cache cap. `protect-foundations` was firing
  at 9 GB / target 8 GB, leaving ~2 GB unused. In practice GitHub
  allows transient overshoot to ~13.6 GB before its own
  non-deterministic LRU kicks in. New values: trigger 9.5 GB,
  target 9.0 GB — ~0.5 GB headroom for one in-flight upload to
  land safely, 0.5 GB hysteresis to prevent thrash. Our
  controlled eviction still fires before GitHub's, protecting
  foundation prefixes from arbitrary LRU. `aggressive` (7/6 GB)
  and the 6h/2h age floor from v0.9.48 are unchanged.

## v0.9.48 - 2026-06-01

- **CRITICAL fix** for cache-eviction-policy self-eviction
  regression (closes #352). v0.9.47's `protect-foundations` policy
  was deleting freshly-saved `cook-base-v2-*` and
  `setup-soldr-buildcache-v2-*` entries (age ~0.1h) because the
  post-step ran eviction immediately after this run's saves
  landed. Next CI cycle then cold-cooked (200s+ vs 5s baseline).
  Two changes:
  - **Age floor**: don't delete entries younger than 6h
    (`protect-foundations`) or 2h (`aggressive`). Protects this
    run's saves + the next CI cycle's restores.
  - **Raised thresholds**: `protect-foundations` 8/7 GB → 9/8 GB,
    `aggressive` 6/5 GB → 7/6 GB. Less eager, 1 GB headroom
    under GitHub's 10 GB repo cache cap.

## v0.9.47 - 2026-06-01

- New `cache-eviction-policy` input (closes #347, #348). Bakes
  repo-level Actions Cache hygiene into setup-soldr's post-step so
  consumers don't need per-repo cleanup workflows. Foundation
  prefixes (`solo-toolchain-v`, `soldr-mini-`, `setup-soldr-v`,
  `setup-soldr-cargoregistry-v`) are NEVER evicted — they deliver
  the warm-CI wins we need to protect. Per-commit/per-lockfile
  entries (cook-delta, build-cache, test/bench artifacts) are
  evictable oldest-first when usage exceeds threshold. Values:
  `disabled` (default), `protect-foundations` (trigger 8 GB,
  target 7 GB), `aggressive` (trigger 6 GB, target 5 GB). Needs
  `actions: write` permission on `GITHUB_TOKEN`; gracefully
  no-ops on 401/403/404. Best-effort throughout — never fails the
  action. Replaces the per-consumer `cache-cleanup.yml` workflow
  pattern.

## v0.9.46 - 2026-06-01

- **BEHAVIOR CHANGE**: solo-toolchain-cache now defaults to `"true"`
  (closes #343, #344). Feature is validated end-to-end across 6
  consumer repos × 3 platforms × ~25 ticks of iteration. Consumers
  that don't explicitly set the input now get the warm-CI win for
  free: solo_restore ~3-5s + rustup_install SKIPPED = ~8-11s saved
  per warm job. Consumers that need opt-out (e.g., workflows that
  install components AFTER setup-soldr — see #334 for the rustfmt
  example) should pass `solo-toolchain-cache: false` explicitly OR
  declare components in their `rust-toolchain.toml`. Also includes
  the dist-verify relaxation (#341/#342) which fixed the
  ~10-tick-long "every PR fails verify" issue. action.yml-only
  change; dist/ unchanged.

## v0.9.45 - 2026-06-01

- Diagnostic counters for solo-cache hardlink fallbacks (closes
  #339). Adds `hardlinkSuccesses` + `copyFallbacks` counters to
  `applyStagedToLiveRoots`; surfaces them in the restore log:
  `applied files=N symlinks=M hardlinks=K copy-fallbacks=L
  (#338 diagnostic)`. macOS solo_restore was observed at 5.5-7.5s
  vs Linux 2.9s — this exposes whether fs.link is silently
  falling back to copyFile on APFS. Zero behavior change; pure
  observability. Next macOS warm run pinpoints the cause and
  unblocks the actual fix.

## v0.9.44 - 2026-06-01

- Hardlinks in seed-isolated-cache (closes #335, #336). Same fix
  pattern as #331 applied to `src/lib/seed-isolated-cache.ts`:
  `fs.copyFileSync` → `fs.linkSync` with EXDEV/EPERM fallback.
  zccache Integration on v0.9.43 was copying 5.46 GB across 1290
  build-cache artifact files (`seed-isolated-build-cache: seeded
  1290 artifact file(s) (5460263998 bytes)`), dominating the
  parallel-restore=35.1s phase. Hardlinks are constant-time on
  the same filesystem; zccache cache entries are content-addressed
  and immutable, so inode sharing is safe. Expected:
  `parallel-restore` drops from 35s → ~8s on Integration, net
  wall clock 41s → ~14s.

## v0.9.43 - 2026-05-31

- Use hardlinks instead of copyFile in solo-cache apply step
  (closes #331, #332). After the solo-cache series finally
  delivered HIT in v0.9.42, demo workflow data showed
  `toolchain=9.4s {solo_restore=9.1s rustup_install=0.2s}` —
  the install was correctly skipped, but solo_restore itself
  was dominated by 153 sequential `fsp.copyFile` calls over
  ~580 MB of toolchain content. Hardlinks via `fsp.link` are
  constant-time on hosted runners where staging and live
  RUSTUP_HOME share a filesystem. Expected drop: ~5s per warm
  job. Combined with #324: ~13s/warm-job total ≈ ~65s/CI cycle
  on 5-job workflows.

## v0.9.42 - 2026-05-31

- Add solo-cache schema-version to cache key (closes #328, #329).
  Cache key prefix is now `solo-toolchain-v2-...`. Bumping the
  schema constant invalidates all prior caches automatically —
  prevents the "v0.9.40-saved cache is unreadable by v0.9.41
  reader → manual `gh cache delete` required" foot-gun seen on
  the #326 rollout. Future tar/format changes just bump the
  constant. v2 also forces a fresh save of the new (#326)
  staging-basename structure, so this release is what finally
  delivers the warm-CI win that the #305/#310/#313-#321/#324/
  #326 chain has been chasing: `toolchain=~3s {rustup_install=0.0s
  solo_restore=~2-3s}`.

## v0.9.41 - 2026-05-31

- Fix #316/#321 follow-up — align tar's top-level dir between save
  and restore (closes #326). v0.9.40 cascade revealed
  `solo-toolchain-cache: restored archive was empty`: the archive
  WAS getting restored, but its tar top-level dir
  (`setup-soldr-solo-stage-save/`) didn't match what restore reads
  from (`staged/`). compressCache writes archives via `tar -cf - -C
  parent basename(stagingDir)`, so save's stagingDir basename
  controls the archive's contents. Now save uses
  `${runnerTemp}/setup-soldr-solo-cache/staged` so basename ==
  `staged` (matching restore's stagingOut basename). Also threads
  canonical archive path explicitly via cacheArchivePath option
  to decouple it from stagingDir layout. **Closes the solo-cache
  series end-to-end** — with #305 + #310 + #313-#321 + #324 + #326
  all in place, warm CI should see `toolchain=~3s
  {rustup_install=0.0s solo_restore=~2-3s}`.

- Skip `rustup install` when solo-toolchain-cache exact-hit verified
  (closes #323, #324). After #316/#321 unblocked solo-cache restore,
  data showed `toolchain=10.3s {rustup_install=8.4s solo_restore=2.0s}`
  on zccache Clippy — the 2s restore worked, but ensureRustToolchain
  was still called unconditionally, and `rustup toolchain install`
  costs ~8s as a no-op on hosted runners (self-update check,
  metadata fetch, profile diff). Now skipped on the verified
  exact-hit path. **Final piece of the solo-cache series**: with
  #305 + #310 + #313-#321 + #324 all in place, warm CI should now
  see `toolchain=Xs {rustup_install=0.0s solo_restore=~2s}` —
  delivering ~8 s per warm job × 5 jobs ≈ ~40 s/cycle in zccache.

## v0.9.39 - 2026-05-31

- **MAJOR**: Fix solo-toolchain-cache restore-MISS-despite-cache-exists
  (closes #316, #321). Save was passing
  `/runner/temp/setup-soldr-solo-stage-save.tar.zst` and restore was
  passing `/runner/temp/setup-soldr-solo-cache/solo-toolchain.tar.zst`
  to `@actions/cache.{saveCache,restoreCache}`. The library SHA-hashes
  the paths array into the cache "version" — different paths = different
  version = restore returns MISS even when GitHub Actions Cache has an
  entry with that key on the same branch scope. The cache was being
  saved successfully on every workflow run but never restored,
  explaining why `rustup_install=8s` persisted on warm CI despite the
  entire #302/#304/#305/#310/#313/#314/#317/#319 series of plumbing
  fixes. Added `soloCacheArchivePath(runnerTemp)` returning a
  canonical path that both sides (including lookupOnly probes) now
  use. Expected impact: solo-cache HITS materialize on warm runs;
  `rustup_install` drops to ~0s; `solo_restore` becomes a real
  ~3-5s ~170 MB extraction.

## v0.9.38 - 2026-05-31

- Fix #313/#314 lookupOnly probe ALWAYS erroring in production
  (closes #317). The probe in v0.9.37 was passing an empty paths
  array to `cache.restoreCache(..., { lookupOnly: true })`, which
  the @actions/cache library rejects with `Path Validation Error:
  At least one directory or file path is required`. Result: the
  race-precheck-skipped path NEVER fired in v0.9.37, so the
  intended ~3-4 min/cold-cycle savings were not delivered. Fixed
  by passing a throwaway runner-temp subdir; with lookupOnly the
  directory contents are never touched.

## v0.9.37 - 2026-05-31

- Pre-save lookupOnly probe for solo-toolchain-cache (closes #313,
  #314). When N parallel jobs in a single workflow all enable
  solo-toolchain-cache with the same key (rustc × components ×
  targets × soldr-version), each one used to stage+compress+upload
  the ~140-175 MB archive only for GitHub Actions Cache to reject
  all-but-one with `id=-1`. zccache CI v0.9.35 showed 3 parallel
  jobs each spending ~100s of post-step wall clock on wasted
  uploads. Fix: probe with `restoreCache([], key, [], {lookupOnly:
  true})` before staging; if the key already exists, skip the
  whole stage+compress+upload chain. Expected savings on a 5-job
  workflow: ~3-4 min per cold-save cycle. Race window narrowed to
  ~50-200 ms (probe duration); worst case is 2 wasted uploads
  instead of N.

## v0.9.36 - 2026-05-31

- solo-toolchain-cache default zstd compression dropped from -19 to
  -9 (closes #310, #311). Measured first cold-save cycle on zccache
  CI showed -19 produced a 140 MB archive in 104.8 s wall clock — 1.3
  MB/s, dominating the entire post-step. The amortization argument
  for -19 ("save once, restore N times") assumed save was cheap;
  measurement showed it wasn't. At -9 the archive grows ~25% (~175
  MB) but compress drops to ~10 s; restore stays bandwidth-bound at
  ~70 MB/s either way. Net ~92 s shaved every cold-save cycle
  (rustc / soldr version bump). Users can still override to "19"
  explicitly.

## v0.9.35 - 2026-05-31

- FS-first rustup probe (closes #304, #308). `systemRustupSatisfiesRequest`
  used to start with `rustup toolchain list` — a child-process spawn
  observed at ~7s on every warm zccache CI run (real numbers from
  #302 sub-phase data on v0.9.34). Replaced with a `readdirSync(
  $RUSTUP_HOME/toolchains)`: same information source rustup itself
  reads, sub-ms instead of seconds. Fast-paths the channel-absent
  case to return BEFORE `which("rustup")` too. Components/targets/
  rolling-release checks still spawn rustup when needed; those are
  rare on consumer workloads (zccache passes no components or
  targets). Expected win: ~7s shaved per warm zccache CI job.

## v0.9.34 - 2026-05-31

- Sub-phase observability for `resolve` / `toolchain` (closes #302,
  #303). Added `timeSubPhase(parent, name, body)` to
  `src/lib/phase-timing.ts` — records aggregated ms into
  `SETUP_SOLDR_PHASE_<parent>_SUB_<name>_MS` and propagates errors
  while still recording the duration. Wired around the high-value
  awaits inside `resolve` (toolchain-spec, rustup-probe,
  soldr-version, ws-hash, lock-hash) and `toolchain` (snapshot-pre/
  base/post, solo-restore, rustup-install). `setupPhaseSummaryOneLine`
  now appends `{sub=Xs sub=Ys}` (slowest first) for any parent ≥ 1s,
  so the post-run one-liner attributes time inside the two largest
  pre-build phases. First real data on the demo workflow surfaced
  two follow-up issues: #304 (rustup_probe=2.4s warm — cache the
  answer) and #305 (rustup_install=9.2s warm even when solo_restore
  was the cache pathway — short-circuit on exact-hit).

## v0.9.33 - 2026-05-31

- Parallel zstd decompression (closes #295 Fix A, #300). Single-flag
  change to `decompressCache`: pass `-T0` so zstd uses all available
  CPU cores. On 4-vCPU hosted Linux runners this should drop the
  multi-GiB build-cache restore from ~17s (single-threaded ~60 MB/s)
  to ~5-7s (~200+ MB/s). Applied to both the with-zstd-CLI and
  fallback-via-tar paths in `cache-compress.ts`. `-T0` is supported
  by all zstd ≥ 1.3.2 (Aug 2017) and is a no-op on single-core
  hosts — safe to add unconditionally.

## v0.9.32 - 2026-05-31

- Parallelize independent workspace hash walks in the resolve phase
  (#298). `workspaceManifestHash` + `cargoConfigHash` were running
  sequentially via `await ; await` even though they're independent
  file-system walks on disjoint subsets of the same workspace dir.
  Now via `Promise.all([...])`. Small companion win to #296 — saves
  resolve wall-clock equal to the smaller of the two hashes.

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
