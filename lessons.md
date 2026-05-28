# setup-soldr — lessons

Field notes captured from real consumer integrations. Each entry is a mistake made (or nearly made)
and the rule that prevents repeating it. Companion to the design principles in `CLAUDE.md`.

## `prebuild-deps-flags` must match the profile the consumer's job actually compiles

**Date:** 2026-05-28 · **Source:** zccache CI audit (`zccache` repo, branch `chore/setup-soldr-0.9.13`)

`prebuild-deps-flags` defaults to `--release`, so a bare `prebuild-deps: soldr-cook` cooks the
dependency graph in the **release** profile. But the most common CI jobs — `cargo check`,
`cargo clippy`, `cargo doc` — compile in the **dev/debug** profile. Profile is part of the
content-addressed compile-cache key (a release `.rlib` is a different artifact than a debug one), so a
release cook produces **zero reuse** for a debug job: the cook wall-time is wasted *and* the release
dep artifacts bloat the saved build cache without ever being read back.

zccache had exactly this on its `clippy`, `msrv` (`cargo check`), and `docs` jobs — they inherited the
`--release` default while compiling debug. The fix mirrors the jobs that were already correct
(`ci-check`, `integration`, `coverage`): set `prebuild-deps-flags: ""` so cook builds debug deps that
the job (and its future runs) actually reuse.

**Rule:** cook in the profile the job compiles.
- debug check/clippy/doc/test jobs → `prebuild-deps-flags: ""`
- release builds / `cargo install` steps → `--release` (the default)
- jobs that don't compile (e.g. `fmt`) → `prebuild-deps: none`

**Product implication for setup-soldr:** the `--release` default is a quiet footgun for the single most
common consumer job shape (debug `cargo check`/`clippy`). Worth considering: warn when cook flags imply
release but the subsequent cargo invocation is a check/clippy/doc, or document this pairing prominently
next to the `prebuild-deps` input.

## `prebuild-deps: none` disables cook only — NOT the build cache

**Date:** 2026-05-28 · **Source:** same audit (over-correction caught in review)

`prebuild-deps` (cook pre-warming) and `build-cache` (zccache compile-cache restore/save) are
independent inputs. Disabling cook with `prebuild-deps: none` does **not** stop the job's compiles from
being saved to / restored from the build cache. The "save state that makes future runs faster" is the
build cache, which stays on by default.

I briefly set `prebuild-deps: none` on zccache's `dylint` job arguing "cook can't be reused here so
it's wasted" — wrong on two counts: (1) it doesn't touch the actual cross-run save-state (build cache,
still on), and (2) cook still warms the *other* compiles in the job. The job was reverted to cooking.

**Rule:** never reach for `prebuild-deps: none` to "preserve build state for future runs" — that's the
build cache's job and it's already on. Use `none` only when the job genuinely compiles nothing.

## cook runs under the configured toolchain; a job compiling under a *different* toolchain can't reuse it

**Date:** 2026-05-28 · **Source:** same audit (zccache `dylint` job)

`soldr cook` runs under the toolchain setup-soldr pins (`toolchain:` / `rust-toolchain.toml`, typically
stable). The toolchain identity is part of the cache key, so a job phase that compiles under a
*different* toolchain cannot reuse cook output. zccache's `dylint` job is the example: its dominant
compile is `cargo dylint --all --workspace` running under `nightly-2026-03-26` (a custom dylint
driver), installed *after* setup-soldr ran — cook (stable) can never warm that nightly pass. cook still
earns its place there because the job's stable-toolchain heavy steps (`cargo install cargo-dylint` /
`dylint-link`, both release) reuse overlapping release deps, and the build cache captures the nightly
compile regardless.

**Rule:** when reasoning about whether cook helps a job, match three axes — **toolchain**, **profile**,
and **emit kind** (check/metadata vs build/codegen). A mismatch on any of them means no reuse from cook,
but the build cache (content-addressed, saved per run) still carries that work forward.
