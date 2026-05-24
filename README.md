# setup-soldr

[![Setup Soldr Action](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml/badge.svg)](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml)

Public GitHub Action for installing one released `soldr` binary, provisioning the resolved Rust toolchain with `rustup`, and restoring cacheable Soldr/zccache state without rehydrating large Cargo or rustup homes by default. The default Soldr version is `0.7.33`.

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

### Reusable Rust CI workflow

For repos that just want the standard Rust quality gates
(`build`, `fmt`, `lint`, `clippy`, `test`, optional `dylint`) wired up on
top of `setup-soldr` without hand-rolling them, this repo ships a
reusable workflow at `.github/workflows/rust-ci.yml`. It uses a
warm-then-fan-out pattern: a single `warm` job runs `setup-soldr` plus
`soldr cargo build --workspace --all-targets` to populate the caches,
then each per-tool job re-runs `setup-soldr` (same SHA = same cache
key, so it hits the freshly-saved cache) and runs its own `soldr
cargo …` invocation. Per-tool jobs are independently toggleable.

Publishing / artifact / release work is intentionally out of scope —
release flows vary too much across repos to template.

#### Inputs

| Name | Type | Default | Purpose |
| --- | --- | --- | --- |
| `os` | string | `ubuntu-latest` | Runner label. |
| `target` | string | `""` (host) | Rust target triple. Non-empty triggers `rustup target add` + `--target` on every cargo invocation. |
| `toolchain` | string | `""` | Forwarded to `setup-soldr`. Empty = `rust-toolchain.toml` or `stable`. |
| `features` | string | `""` | Forwarded as `--features` to the warm build. |
| `cargo-args` | string | `""` | Free-form extra args appended to the warm build. |
| `cache` | boolean | `true` | Forwarded to `setup-soldr`'s umbrella cache switch. |
| `lint` | boolean | `true` | `cargo check --workspace --all-targets`. |
| `fmt` | boolean | `true` | `cargo fmt --all -- --check`. |
| `clippy` | boolean | `true` | `cargo clippy --workspace --all-targets -- -D warnings`. |
| `test` | boolean | `true` | `cargo test --workspace`. |
| `dylint` | boolean | `false` | `cargo dylint --all --workspace` (installs `cargo-dylint` + `dylint-link` first). Opt-in: needs a consumer-provided `dylint.toml`. |

#### Simple consumer

```yaml
jobs:
  ci:
    uses: zackees/setup-soldr/.github/workflows/rust-ci.yml@v0
    with:
      os: ubuntu-latest
      dylint: false
```

#### Cross-compile matrix

```yaml
jobs:
  ci:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: ubuntu-latest,  target: x86_64-unknown-linux-gnu }
          - { os: ubuntu-latest,  target: aarch64-unknown-linux-musl }
          - { os: macos-latest,   target: aarch64-apple-darwin }
          - { os: windows-latest, target: x86_64-pc-windows-msvc }
    uses: zackees/setup-soldr/.github/workflows/rust-ci.yml@v0
    with:
      os:     ${{ matrix.os }}
      target: ${{ matrix.target }}
      test:   ${{ matrix.target == 'x86_64-unknown-linux-gnu' }}
```

Cross-compiled binaries usually can't run on the host, so the matrix
example gates `test:` on the native cell. The template never tries to
auto-detect runnability — the consumer chooses.

## Multi-platform builds (cross-target tutorial)

The single-platform examples above all build for the runner's own host
target. The moment you ask one runner to build for a different triple — for
example, a Windows x86 runner producing a `aarch64-pc-windows-msvc`
binary — you have left the native-host world and entered cross-compilation.
The Rust standard library for the cross target must be provisioned on the
runner *before* `soldr cargo build --target <triple>` runs, or the
compilation fails with `error[E0463]: can't find crate for core` /
`std`. This tutorial walks through both modes end-to-end against the
public `setup-soldr@v0` action.

### Native host targets vs cross-compilation targets

| Mode | Example | What needs to be installed |
|---|---|---|
| Native host build | `ubuntu-latest` builds `x86_64-unknown-linux-gnu`, `macos-latest` builds `aarch64-apple-darwin`, `windows-latest` builds `x86_64-pc-windows-msvc` | Nothing extra — `rustup` installs the host `rust-std` by default. `soldr cargo build` (no `--target`) just works. |
| Cross-target build | `windows-latest` (x86 host) builds `aarch64-pc-windows-msvc`; `ubuntu-latest` builds `aarch64-unknown-linux-gnu`; any host builds `wasm32-unknown-unknown` | The matching `rust-std` for the cross target must be added with `rustup target add <triple>` before `cargo` runs. Native linkers / sysroots may also be required depending on the triple. |

`setup-soldr` reads both `[toolchain].components` and `[toolchain].targets`
from the toolchain file (the `toolchain-file` input, default
`rust-toolchain.toml`) and runs `rustup target add` for every requested
target during setup. The exact log line to look for is:

```
Requested Rust targets: aarch64-pc-windows-msvc
```

A reading of `Requested Rust targets: none` means the action did not see
any targets in the toolchain spec — even if your workflow believed it
generated one. Grep your setup-soldr step logs for that line to confirm
what the action actually saw.

### `rust-toolchain.toml` with static cross targets

When the same set of cross targets is needed by *every* job that builds the
crate (local dev, CI, releases), pin them in the committed
`rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.94.1"
profile = "minimal"
components = ["rustfmt", "clippy"]
targets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
]
```

`setup-soldr@v0` picks this file up automatically because the
`toolchain-file` input defaults to `rust-toolchain.toml`. Every job that
runs the action provisions all listed targets up front, regardless of
which target that particular job actually builds. This is the simplest
shape and the right default for small matrices.

### Per-job `rust-toolchain.ci.toml` (reusable pattern)

Provisioning every target in every job wastes time when the matrix is
large or when only one job ever needs an exotic target. The reusable
pattern is to generate a per-job toolchain file at runtime and point
`setup-soldr` at it with the `toolchain-file` input:

```yaml
      - name: Write per-job toolchain spec
        shell: bash
        run: |
          cat > rust-toolchain.ci.toml <<'EOF'
          [toolchain]
          channel = "1.94.1"
          profile = "minimal"
          components = ["rustfmt", "clippy"]
          targets = ["${{ matrix.target }}"]
          EOF
          cat rust-toolchain.ci.toml

      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          toolchain-file: rust-toolchain.ci.toml
```

Two things to keep in mind:

- The `toolchain-file` path is resolved relative to `${{ github.workspace }}`,
  so generate the file at the repo root (or pass a workspace-relative path).
- The `toolchain` input takes precedence over `toolchain-file`. Leave
  `toolchain` empty (the default) when you want the file to win.

### Full matrix: Linux/macOS/Windows native plus Windows ARM cross

The example below is copy-pasteable. The four native jobs each build for
their own host triple; the fifth job runs on a Windows x86 runner and
cross-compiles to `aarch64-pc-windows-msvc`.

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  build:
    name: build (${{ matrix.name }})
    runs-on: ${{ matrix.runner }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: linux-x86_64
            runner: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - name: macos-aarch64
            runner: macos-latest
            target: aarch64-apple-darwin
          - name: windows-x86_64
            runner: windows-latest
            target: x86_64-pc-windows-msvc
          - name: windows-aarch64-cross
            runner: windows-latest
            target: aarch64-pc-windows-msvc
    steps:
      - uses: actions/checkout@v4

      - name: Write per-job toolchain spec
        shell: bash
        run: |
          cat > rust-toolchain.ci.toml <<'EOF'
          [toolchain]
          channel = "1.94.1"
          profile = "minimal"
          components = ["rustfmt", "clippy"]
          targets = ["${{ matrix.target }}"]
          EOF
          cat rust-toolchain.ci.toml

      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          toolchain-file: rust-toolchain.ci.toml
          cache-key-suffix: ${{ matrix.target }}

      - name: Build
        run: soldr cargo build --locked --release --target ${{ matrix.target }}

      - name: Test (host targets only)
        if: matrix.target != 'aarch64-pc-windows-msvc'
        run: soldr cargo test --locked --target ${{ matrix.target }}
```

Notes on the matrix:

- `cache-key-suffix: ${{ matrix.target }}` keeps the per-target caches
  separate so a Windows ARM artifact set never collides with the Windows
  x86 one.
- The `aarch64-pc-windows-msvc` job builds but does not run tests, because
  the runner is x86 and cannot execute ARM64 Windows binaries natively.
  Run those tests on an ARM runner or under emulation in a separate job.
- For Linux ARM cross-compiles (`aarch64-unknown-linux-gnu`), you typically
  also need to install `gcc-aarch64-linux-gnu` and set
  `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc`
  before `soldr cargo build` runs. See the troubleshooting section below
  if your cross-link fails with a missing-linker error.

### Troubleshooting cross-target builds

#### `error[E0463]: can't find crate for core` (or `std`)

```
error[E0463]: can't find crate for `core`
  |
  = note: the `aarch64-pc-windows-msvc` target may not be installed
  = help: consider downloading the target with `rustup target add aarch64-pc-windows-msvc`
```

The `rust-std` component for the cross target was never installed on the
runner. Confirm the failure mode in the setup-soldr step logs:

1. Grep for `Requested Rust targets:` in the setup-soldr step output.
2. If the line reads `Requested Rust targets: none`, the action did not
   see your target. Fix the toolchain file (see next subsection).
3. If the line lists the expected target but the build still fails, the
   `rustup target add` itself failed earlier in the same step — scroll up
   for a `rustup` error.

#### Setup logs show `Requested Rust targets: none`

This means `setup-soldr` parsed an empty `[toolchain].targets` array.
Common causes:

- The `toolchain-file` input points at a path the action cannot find.
  Paths are resolved relative to `${{ github.workspace }}`. If you wrote
  the file from a sub-directory or to an absolute path, move it (or pass
  the workspace-relative path).
- The generated file has a typo. The action expects exactly
  `[toolchain]` and `targets = [ ... ]`. A misspelled section header
  (`[tool-chain]`, `[Toolchain]`) silently produces an empty spec.
- The `toolchain` input is set to a non-empty string. When `toolchain` is
  set, it overrides the channel but `setup-soldr` still reads
  `components` and `targets` from the file — but only if the file exists
  and parses. Print the file with `cat` (or `Get-Content`) before the
  `setup-soldr` step to confirm what the action will see.

#### Always grep the action's log line

Before opening a bug, search the `setup-soldr` step log for these two
lines:

```
Requested Rust components: <list-or-none>
Requested Rust targets: <list-or-none>
```

They are emitted unconditionally on every run from
`ensure-rust-toolchain.ts`. If those lines do not show the targets you
expect, the bug is in your toolchain file or `toolchain-file` input, not
in `rustup` or `cargo` — fix the spec first.

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
| `version` | Soldr release tag or version to install. Defaults to `0.7.33`. |
| `token` | GitHub token used for authenticated release metadata and asset download requests. Defaults to `${{ github.token }}`. |
| `cache` | Restore and save the action-managed cache/state root. |
| `cache-dir` | Override the runner-local cache/state root used for the installed `soldr` binary and any managed rustup state this action rehydrates. |
| `cache-key-suffix` | Optional escape hatch appended to the cache key. |
| `toolchain` | Explicit Rust toolchain channel override. |
| `toolchain-file` | Alternate toolchain file path when `toolchain` is empty; `components` and `targets` in the file are provisioned during setup. |
| `trust-mode` | Optional `SOLDR_TRUST_MODE` value. |
| `linker` | Linker override forwarded as `SOLDR_LINKER` (requires soldr 0.7.19+). Empty (default) selects `fast` — mold-if-on-PATH-else-rust-lld on Linux, rust-lld on macOS/Windows — and emits a one-time GitHub Actions warning so the override is visible in CI logs. Soldr's native default is no injection (smaller artifact cache, slower link); pass `platform-default` (or `default`) to opt out and keep cargo/rust-toolchain.toml in charge. Other accepted values pass through verbatim: `ld`, `mold`, `rust-lld`, `fast`. Unknown values raise an error. |
| `compile-priority` | Compiler/linker child-process priority forwarded as `ZCCACHE_COMPILE_PRIORITY` (requires zccache 1.4.6+). Defaults to `high` because CI runners are dedicated and have no foreground workload to yield to. zccache's native default is `low` (designed for interactive dev). Accepted: `normal`, `low`, `idle`, `high`. Set to empty string to opt out and let zccache pick its native default. |
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

- The action installs exactly one released `soldr` binary for the active runner target, defaulting to Soldr `0.7.33`.
- The normal path provisions Rust with `rustup`, bootstrapping `rustup` when it is absent.
- Toolchain-file `components` and `targets` are installed during setup so later `cargo`/`soldr cargo` steps do not trigger rustup lazy installs.
- The action keeps using the runner's existing `CARGO_HOME` unless `CARGO_HOME` is already set by the workflow. When `RUSTUP_HOME` is not explicitly set, setup-soldr prefers the runner's existing rustup home if it already satisfies the requested toolchain/components/targets; otherwise it falls back to a managed `RUSTUP_HOME` under the action cache root and rehydrates that state on later warm runs.
- The action restores Soldr/zccache cache state by default so child branches can reuse parent-branch build state.
- The default `build-cache-mode` is `once`, which maps to soldr/zccache full-target planning on a cold run but restores only the local rust-plan bundle on later hits. Use `build-cache-mode: thin` for the bounded dependency-artifact alternative, or `build-cache-mode: full` when you explicitly want normal whole-target restore/save behavior on every run.
- In `once` mode, an exact rust-plan bundle hit skips the separate build-cache restore because the target bundle already rehydrates the warm artifacts needed for the following build.
- setup-soldr now emits soft target-cache footprint budgets by mode: `once` warns above `1 GiB` or `8000` files, `thin` warns above `512 MiB` or `4000` files, and `full` warns above `2 GiB` or `12000` files.
- When the restored target-cache footprint exceeds that soft budget, the setup step emits a warning and reports `target-cache-budget-status=over-soft-budget:...` so workflows can spot cache shapes that are unlikely to stay fast.
- setup-soldr also emits `setup-duration-seconds` plus a JSON `setup-phase-summary` output so warm-path investigations can compare cache restore time against toolchain/install/verify overhead.
- During post-job finalization, setup-soldr writes a GitHub step summary with restore/save outcomes for the setup, target, build, and Cargo registry cache layers. When soldr emits `last-session-stats.json`, the summary includes zccache hit/miss counts, hit rate, compilation count, non-cacheable count, errors, and the stats file path.
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
