# setup-soldr

[![Setup Soldr Action](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml/badge.svg)](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml)

Public GitHub Action for installing one released `soldr` binary, provisioning the resolved Rust toolchain with `rustup`, and restoring cacheable Soldr/zccache state without rehydrating large Cargo or rustup homes by default. The default Soldr version is `0.7.14`.

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

## Inputs

| Input | Meaning |
|---|---|
| `version` | Soldr release tag or version to install. Defaults to `0.7.14`. |
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
| `source-mtime-normalize` | Opt-in. When `true`, rewrite the mtime of tracked Rust build-input files under `${{ github.workspace }}` to each file's last-commit timestamp before the target-cache restore. Default `false`. See "Source mtime normalization" below. |

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

- The action installs exactly one released `soldr` binary for the active runner target, defaulting to Soldr `0.7.14`.
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

`thin-v2` is opt-in. **Stay on `thin-v1` until the zccache repopulation hook
(soldr#237 Phase 2) has shipped and the
[`thin-v2-verify`](https://github.com/zackees/soldr/blob/main/.github/workflows/thin-v2-verify.yml)
gate has been green on soldr `main` for at least one week.** Setting
`thin-v2` before that point can leave the restored target slice missing
library bytes that the build still needs.

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          target-cache-profile: thin-v2
      - run: soldr cargo build --locked --release
```

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

Clone with submodules, or initialize them after clone:

```bash
git clone --recurse-submodules https://github.com/zackees/setup-soldr.git
```

```bash
git submodule update --init --recursive
```

The repository now carries pinned `soldr/` and `zccache/` Git submodules for local source inspection against the exported action bundle.

For cross-repo integration work, the action also carries hidden `repo` and `ref`
inputs. When `ref` is set, setup-soldr downloads the GitHub source archive for
that ref, builds `soldr` locally, and caches it under the normal setup root so
`fast-gh-rebuild` style branch loops can exercise unreleased Soldr changes.

Regenerate this repository bundle from the source repository with the exporter in `zackees/soldr`.
