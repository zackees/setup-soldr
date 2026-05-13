# setup-soldr

[![Setup Soldr Action](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml/badge.svg)](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml)

Public GitHub Action for installing one released `soldr` binary, provisioning the resolved Rust toolchain with `rustup`, and restoring cacheable Soldr/zccache state without rehydrating large Cargo or rustup homes by default. The default Soldr version is `0.7.18`.

This repository is intended to be generated from `zackees/soldr`. The source-of-truth contract and release process still live in `soldr` issue #137 and `docs/SETUP_SOLDR_PUBLIC_ACTION.md`.

## Usage

### Linux

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
      - run: soldr cargo build --locked --release
      - run: soldr cargo test --locked
```

### macOS

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
      - run: soldr cargo build --locked --release
      - run: soldr cargo test --locked
```

### Windows

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
      - run: soldr cargo build --locked --release
      - run: soldr cargo test --locked
```

## GitHub API Authentication

`setup-soldr` calls the GitHub Releases API to resolve the requested
`soldr` release and download its platform asset. The action authenticates those
requests by default with the workflow's `${{ github.token }}` through its
`token` input. This avoids anonymous API rate limits and transient HTTP 403
failures on busy CI matrices.

Most workflows do not need to configure anything:

```yaml
- uses: zackees/setup-soldr@v0
  with:
    cache: true
```

To override the token, pass a token with read access to the release repository:

```yaml
- uses: zackees/setup-soldr@v0
  with:
    token: ${{ secrets.SOLDR_RELEASE_TOKEN }}
    cache: true
```

For compatibility with older workflows, `setup-soldr` also honors a
`GITHUB_TOKEN` environment variable on the step. The explicit `token` input is
preferred for new workflows.

## Inputs

| Input | Meaning |
|---|---|
| `version` | Soldr release tag or version to install. Defaults to `0.7.18`. |
| `token` | GitHub token used for authenticated release metadata and asset download requests. Defaults to `${{ github.token }}`. |
| `cache` | Restore and save the action-managed cache/state root. |
| `cache-dir` | Override the runner-local cache/state root used for the installed `soldr` binary and any managed rustup state this action rehydrates. |
| `cache-key-suffix` | Optional escape hatch appended to the cache key. |
| `toolchain` | Explicit Rust toolchain channel override. |
| `toolchain-file` | Alternate toolchain file path when `toolchain` is empty; `components` and `targets` in the file are provisioned during setup. |
| `trust-mode` | Optional `SOLDR_TRUST_MODE` value. |
| `timestamps` | Prefix setup-soldr diagnostics and streamed command output with elapsed `mm:ss` timestamps. Default `true`; set to `false` to opt out. |
| `lockfile` | Optional `Cargo.lock` path used for Rust artifact cache keying. Empty infers `Cargo.lock` next to `target-dir`, then workspace `Cargo.lock`. |
| `build-cache` | Restore and save Soldr/zccache build cache state across runs. Default `true`; set to `false` to opt out. |
| `build-cache-mode` | Rust build cache mode. Default `once` saves a full snapshot on miss, then restores only the local rust-plan bundle on later hits without resaving the full target tree. `thin` is the bounded dependency-artifact alternative. `full` opts into normal whole-target restore/save behavior and should be treated as unbounded. |
| `target-dir` | Cargo target directory used by soldr when constructing the Rust artifact cache plan. |
| `target-cache-profile` | Thin-slice pruning policy for the `target/` cache. `thin-v1` (default) keeps `.rlib`/`.rmeta`/proc-macro outputs. `thin-v2` is the aggressive prune that keeps fingerprints + dep-info + final outputs only and relies on the zccache compilation cache to repopulate library bytes. See "Target cache profile" below before opting in. |
| `target-cache-strip-debuginfo` | Forward-compatible pass-through. When `true`, requests that soldr strip debug-info-bearing artifacts from the target-cache before saving. Requires soldr#237 to take effect; current soldr releases ignore the flag. Default unset (soldr default applies). See "Forward-compatible target-cache pruning inputs" below. |
| `target-cache-include-incremental` | Forward-compatible pass-through. When `false`, requests that soldr exclude `target/*/incremental/` directories from the target-cache. Requires soldr#237 to take effect. Default unset (soldr default applies). See "Forward-compatible target-cache pruning inputs" below. |
| `target-cache-include-build-script-binaries` | Forward-compatible pass-through. When `false`, requests that soldr exclude `target/*/build/*-{hash}/build-script-build` binaries from the target-cache. Requires soldr#237 to take effect. Default unset (soldr default applies). See "Forward-compatible target-cache pruning inputs" below. |
| `source-mtime-normalize` | Opt-in. When `true`, rewrite the mtime of tracked Rust build-input files under `${{ github.workspace }}` to each file's last-commit timestamp before the target-cache restore. Default `false`. See "Source mtime normalization" below. |
| `cargo-registry-cache` | When `true` (default), setup-soldr caches `~/.cargo/registry` directly as a fast-zstd `.tar.zst` and exports `SOLDR_SKIP_CARGO_REGISTRY_SAVE=1` so zccache CLI's built-in registry save no-ops. Requires zccache `>=1.4.4` (skip-flag support). Set to `false` to opt out and let zccache own the registry cache via its legacy gzip path. |

### Legacy Compatibility Inputs

| Input | Meaning |
|---|---|
| `target-cache` | Deprecated compatibility input. Set to `false` to disable Rust target artifact caching. |
| `target-cache-mode` | Deprecated compatibility input translated into `build-cache-mode`: `hot` maps to `thin`, `full` maps to `full`, and `off` disables Rust target artifact caching. |

## Outputs

| Output | Meaning |
|---|---|
| `soldr-path` | Installed Soldr binary path added to `PATH`. |
| `soldr-version` | Installed Soldr version reported by `soldr version --json`. |
| `cache-dir` | Action-managed runner-local cache/state root. |
| `setup-duration-seconds` | Total wall-clock time spent inside the setup-soldr action. |
| `setup-phase-summary` | JSON timing summary for the main setup phases and cache restore statuses. |
| `cache-hit` | Whether the action restored an exact cache hit. |
| `cache-key` | Primary key used for the action-managed cache/state root. |
| `cache-restore-status` | Diagnostic restore status for the action-managed cache/state root. |
| `build-cache-hit` | Whether the Soldr-owned zccache compilation cache was restored. Empty only when `build-cache` is disabled. |
| `build-cache-key` | Primary key used for the Soldr-owned zccache compilation cache. |
| `build-cache-path` | Soldr-owned zccache compilation cache path. |
| `build-cache-mode` | Effective setup-soldr Rust build cache mode. |
| `build-cache-restore-status` | Diagnostic restore status for the Soldr-owned zccache compilation cache. In `once` mode this may report `skipped-target-cache-exact-hit` when the rust-plan bundle was already an exact hit and the separate compile-cache restore was intentionally skipped. |
| `target-cache-hit` | Whether the zccache-owned Rust artifact cache state was restored. |
| `target-cache-key` | Primary key used for the zccache-owned Rust artifact cache state. |
| `target-cache-path` | Cargo target directory used by soldr for Rust artifact planning. |
| `target-cache-paths` | Path or newline-delimited path list passed to `actions/cache` for zccache-owned Rust artifact cache state. |
| `target-cache-mode` | Effective setup-soldr Rust target artifact cache mode. |
| `target-cache-profile` | Effective setup-soldr thin-slice pruning policy (`thin-v1` or `thin-v2`). |
| `target-cache-restore-status` | Diagnostic restore status for the Rust target artifact cache state. |
| `target-cache-budget-bytes` | Soft byte budget used to warn when the restored Rust artifact cache footprint is likely too large for fast CI reuse. |
| `target-cache-budget-files` | Soft file-count budget used to warn when the restored Rust artifact cache footprint is likely too large for fast CI reuse. |
| `target-cache-footprint-bytes` | Observed byte size of the restored Rust artifact cache footprint across the cache paths selected for the current mode. |
| `target-cache-footprint-files` | Observed file count of the restored Rust artifact cache footprint across the cache paths selected for the current mode. |
| `target-cache-budget-status` | Soft-budget diagnostic for the restored Rust artifact cache footprint. |
| `target-lockfile` | `Cargo.lock` path used for Rust artifact cache keying. |
| `target-lockfile-hash` | Short hash of the `Cargo.lock` used for Rust artifact cache keying, or `no-lock`. |
| `toolchain` | Exact Rust toolchain channel configured for the action. |

## Notes

- The action installs exactly one released `soldr` binary for the active runner target, defaulting to Soldr `0.7.18`.
- The normal path provisions Rust with `rustup`, bootstrapping `rustup` when it is absent.
- Toolchain-file `components` and `targets` are installed during setup so later `cargo`/`soldr cargo` steps do not trigger rustup lazy installs.
- The action keeps using the runner's existing `CARGO_HOME` unless `CARGO_HOME` is already set by the workflow. When `RUSTUP_HOME` is not explicitly set, setup-soldr prefers the runner's existing rustup home if it already satisfies the requested toolchain/components/targets; otherwise it falls back to a managed `RUSTUP_HOME` under the action cache root and rehydrates that state on later warm runs.
- The action restores Soldr/zccache cache state by default so child branches can reuse parent-branch build state.
- The default `build-cache-mode` is `once`, which maps to soldr/zccache full-target planning on a cold run but restores only the local rust-plan bundle on later hits. Use `build-cache-mode: thin` for the bounded dependency-artifact alternative, or `build-cache-mode: full` when you explicitly want normal whole-target restore/save behavior on every run.
- In `once` mode, an exact rust-plan bundle hit skips the separate build-cache restore because the target bundle already rehydrates the warm artifacts needed for the following build.
- setup-soldr now emits soft target-cache footprint budgets by mode: `once` warns above `1 GiB` or `8000` files, `thin` warns above `512 MiB` or `4000` files, and `full` warns above `2 GiB` or `12000` files.
- When the restored target-cache footprint exceeds that soft budget, the setup step emits a warning and reports `target-cache-budget-status=over-soft-budget:...` so workflows can spot cache shapes that are unlikely to stay fast.
- setup-soldr also emits `setup-duration-seconds` plus a JSON `setup-phase-summary` output so warm-path investigations can compare cache restore time against toolchain/install/verify overhead.
- zccache is the artifact cache authority; soldr interprets the Rust build and passes zccache a structured Rust artifact plan.
- Inspect `soldr cache`, zccache session stats, and the setup step's restore-status outputs when warm cache reuse is unexpectedly low.
- The setup cache intentionally keeps the installed `soldr` binary and only includes rustup state when setup-soldr had to fall back to a managed `RUSTUP_HOME` under the setup cache root. The dedicated `ZCCACHE_CACHE_DIR` payload stays in its own cache so warm runs do not restore the same build-cache bytes twice.

## Known limitations

### Repeated `soldr cargo build` sharing a target directory

Running `soldr cargo build` twice in a single job against the same Cargo
`target/` directory is currently best-effort and not guaranteed to succeed.
When `build-cache-mode: once` (the default) is combined with a pre-populated
target directory, the second invocation can restore a stale rust-plan bundle
whose `restored_file_count` is `0`, and Cargo then fails with
`error: extern location for ring does not exist: .../libring-*.rmeta`.

When setup-soldr detects that the restored `target-dir` already contains
compiled artifacts (a `deps/` subtree with `.rmeta` files) under the
risky configuration, it emits a GitHub Actions log warning so the pitfall
surfaces before Cargo trips on it.

Recommended workaround: give the second invocation its own `--target-dir`,
or call `cargo build` directly.

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: zackees/setup-soldr@v0
    with:
      cache: true
  - run: soldr cargo build --locked --release
  # Use a distinct target dir for the second build so the first build's
  # rust-plan is not reused with a stale dependency map.
  - run: soldr cargo build --locked --release --target-dir target/python-extension
```

See [issue #53](https://github.com/zackees/setup-soldr/issues/53) for
background.

## Target cache profile

`target-cache-profile` selects the thin-slice pruning policy used when soldr
builds the cached `target/` slice. Two values are accepted:

- `thin-v1` (default): the legacy slice that keeps `.rlib`, `.rmeta`, and
  proc-macro outputs alongside fingerprints, dep-info, and final outputs.
  This preserves the byte-identical behavior shipped before this input
  existed, so no caller regresses by leaving the input unset.
- `thin-v2`: an aggressive prune that keeps only fingerprints, dep-info, and
  final outputs and relies on the zccache compilation cache to repopulate
  library bytes on warm runs.

`thin-v2` is opt-in. [soldr#237](https://github.com/zackees/soldr/issues/237)
shipped in Soldr `0.7.15`, so the CLI now generates the thin-v2 manifest when
`SOLDR_TARGET_CACHE_PROFILE=thin-v2` is set. **Stay on `thin-v1` because
zccache has not yet been updated to honor the new `manifest.v2` wire format;
setting `thin-v2` against any current zccache release causes a silent
downgrade to `thin-v1` with a one-line soldr warning rather than actual
pruning.** The
[`thin-v2-verify`](https://github.com/zackees/soldr/blob/main/.github/workflows/thin-v2-verify.yml)
gate has only been green on soldr `main` since 2026-05-10, so the one-week
watch is still in progress. Opt into `thin-v2` only after a zccache release
ships with `manifest.v2` support and the verify gate has stayed green for a
full week; pin that zccache version alongside the input.

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          target-cache-profile: thin-v2
      - run: soldr cargo build --locked --release
```

## Forward-compatible target-cache pruning inputs

`target-cache-strip-debuginfo`, `target-cache-include-incremental`, and
`target-cache-include-build-script-binaries` are pass-through knobs that
export `SOLDR_TARGET_CACHE_STRIP_DEBUGINFO`,
`SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL`, and
`SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES` env vars for the
downstream soldr CLI when they are set to a non-empty value. **Soldr
`0.7.15` shipped [soldr#237](https://github.com/zackees/soldr/issues/237) as
a single-knob profile selector (`SOLDR_TARGET_CACHE_PROFILE=thin-v2`) and
does not read these three env vars**, so today they have no effect on any
released soldr. To prune the target cache, use `target-cache-profile:
thin-v2` once the wire-format gate described in "Target cache profile"
above has cleared. These three inputs are retained in case a future soldr
release introduces finer-grained per-class toggles; until then they remain
no-ops. Accepted values are `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`;
they are normalized to literal `"true"` or `"false"` before being exported.
See [issue #58](https://github.com/zackees/setup-soldr/issues/58) for
background.

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          target-cache-strip-debuginfo: true
          target-cache-include-incremental: false
          target-cache-include-build-script-binaries: false
      - run: soldr cargo build --locked --release
```

### Measuring target-cache pruning impact

The three pruning inputs above are no-ops on every current soldr release because soldr `0.7.15` chose the `target-cache-profile` selector instead of per-class env vars. The same matrix pattern works against `target-cache-profile` once the wire-format gate clears, and the action's existing footprint outputs and phase-timing summary can be used to measure impact today.

To compare before/after for the same workflow, run a matrix that toggles `target-cache-profile` and reads `target-cache-footprint-bytes`:

```yaml
jobs:
  measure-prune:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        profile: [thin-v1, thin-v2]
    steps:
      - uses: actions/checkout@v4
      - id: setup-soldr
        uses: zackees/setup-soldr@v0
        with:
          cache: true
          target-cache-profile: ${{ matrix.profile }}
      - run: soldr cargo build --locked --release
      - name: Report footprint
        run: |
          echo "profile=${{ matrix.profile }} bytes=${{ steps.setup-soldr.outputs.target-cache-footprint-bytes }} files=${{ steps.setup-soldr.outputs.target-cache-footprint-files }}"
```

To fail a job whose restored cache has drifted past the soft budget, gate on `target-cache-budget-status`; it is `disabled`, `within-soft-budget`, or `over-soft-budget:bytes,files`:

```yaml
      - name: Enforce target-cache budget
        if: startsWith(steps.setup-soldr.outputs.target-cache-budget-status, 'over-soft-budget:')
        run: |
          echo "::error::target-cache over soft budget: ${{ steps.setup-soldr.outputs.target-cache-budget-status }}"
          exit 1
```

Footprint deltas conflate cache-restore time and downstream compile time. To attribute wins to the restore phase only, parse `setup-phase-summary` (a compact JSON object) and read its `target_cache_seconds` field:

```yaml
      - name: Report target-cache restore time
        run: |
          echo '${{ steps.setup-soldr.outputs.setup-phase-summary }}' | jq '.target_cache_seconds'
```

See [soldr#237](https://github.com/zackees/soldr/issues/237) for the upstream artifact-class content policy that determines which files `thin-v2` actually strips.

## Source mtime normalization

Fresh GitHub checkouts assign new mtimes to every file, which can cause Cargo to invalidate fingerprints for packages whose sources did not actually change between a parent branch and a pull request. When `source-mtime-normalize: true` is set, `setup-soldr` rewrites the mtime of tracked Rust build-input files (`**/*.rs`, `**/Cargo.toml`, `**/Cargo.lock`, `**/build.rs`, `rust-toolchain`, `rust-toolchain.toml`) under `${{ github.workspace }}` to each file's last-commit timestamp from `git log -1 --format=%ct`. Files under `target/`, `.git/`, and `node_modules/` are always skipped, and untracked files are left alone, so genuine source edits still invalidate Cargo fingerprints. This is action-side behavior, not a substitute for upstream build-script hygiene, and it is a no-op when the input is `false` or the workspace is not a git work tree.

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          source-mtime-normalize: true
      - run: soldr cargo build --locked --release
```

## Development

`setup-soldr` is a Node 20 JavaScript GitHub Action. The runtime lives in TypeScript under `src/` and is bundled into `dist/main.js` (pre-step) and `dist/post.js` (post-step) with `@vercel/ncc`. The bundled output **is committed** to the repository so consumers running `uses: zackees/setup-soldr@v0` get a self-contained action without needing `npm install` at action runtime.

Clone with submodules, or initialize them after clone:

```bash
git clone --recurse-submodules https://github.com/zackees/setup-soldr.git
```

```bash
git submodule update --init --recursive
```

The repository carries pinned `soldr/` and `zccache/` Git submodules for local source inspection against the exported action bundle.

### Local toolchain

```bash
npm install         # install TypeScript, ncc, and @actions/* runtime deps
npm run typecheck   # tsc --noEmit
npm test            # node --test across __tests__/**/*.test.ts
npm run build       # bundle dist/main.js and dist/post.js with ncc
```

Always re-run `npm run build` after changing anything under `src/` and commit the regenerated `dist/` alongside the source change — CI gates on `git diff --exit-code -- dist/` to catch dist drift.

### Integration knobs

For cross-repo integration work, the action carries hidden `repo` and `ref`
inputs. When `ref` is set, setup-soldr downloads the GitHub source archive for
that ref, builds `soldr` locally, and caches it under the normal setup root so
`fast-gh-rebuild` style branch loops can exercise unreleased Soldr changes.

Regenerate this repository bundle from the source repository with the exporter in `zackees/soldr`.
