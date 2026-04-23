# setup-soldr

[![Setup Soldr Action](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml/badge.svg)](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml)

Public GitHub Action for installing one released `soldr` binary, provisioning the resolved Rust toolchain with `rustup`, and restoring cacheable Soldr/zccache state without rehydrating large Cargo or rustup homes by default. The default Soldr version is `0.7.10`.

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

### Verbose cache debugging

```yaml
- uses: zackees/setup-soldr@v0
  id: setup
  with:
    cache: true
    verbose: true

- run: soldr cargo build --locked

- if: ${{ always() }}
  shell: bash
  run: |
    test -f "${{ steps.setup.outputs.zccache-daemon-log }}" && cat "${{ steps.setup.outputs.zccache-daemon-log }}"
    test -f "${{ steps.setup.outputs.zccache-session-log }}" && cat "${{ steps.setup.outputs.zccache-session-log }}"
```

## Inputs

| Input | Meaning |
|---|---|
| `version` | Soldr release tag or version to install. Defaults to `0.7.10`. |
| `cache` | Restore and save the action-managed cache/state root. |
| `build-cache-mode` | Rust build cache mode. Default `thin` restores bounded dependency artifacts through soldr/zccache. `full` opts into whole-target caching and should be treated as unbounded. |
| `verbose` | Turn on zccache trace logging and expose the daemon/session log paths for debug dump steps. |
| `lockfile` | Optional `Cargo.lock` path used for Rust artifact cache keying. Empty infers `Cargo.lock` next to `target-dir`, then workspace `Cargo.lock`. |
| `target-dir` | Cargo target directory used by soldr when constructing the Rust artifact cache plan. |
| `toolchain` | Explicit Rust toolchain channel override. |
| `toolchain-file` | Alternate toolchain file path when `toolchain` is empty; `components` and `targets` in the file are provisioned during setup. |
| `timestamps` | Prefix setup-soldr diagnostics and streamed command output with elapsed `mm:ss` timestamps. Default `true`; set to `false` to opt out. |

### Advanced Inputs

| Input | Meaning |
|---|---|
| `cache-dir` | Override the runner-local cache/state root. |
| `cache-key-suffix` | Optional escape hatch appended to the cache key. |
| `trust-mode` | Optional `SOLDR_TRUST_MODE` value. |
| `build-cache` | Advanced escape hatch for disabling Soldr/zccache compilation cache restore/save entirely. Default `true`. |

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
| `cache-hit` | Whether the action restored an exact cache hit. |
| `cache-key` | Primary key used for the action-managed cache/state root. |
| `cache-restore-status` | Diagnostic restore status for the action-managed cache/state root. |
| `build-cache-mode` | Effective Rust build cache mode selected for soldr/zccache. |
| `target-cache-path` | Cargo target directory used by soldr for Rust artifact planning. |
| `target-lockfile` | `Cargo.lock` path used for Rust artifact cache keying. |
| `target-lockfile-hash` | Short hash of the `Cargo.lock` used for Rust artifact cache keying, or `no-lock`. |
| `verbose` | Whether verbose zccache logging is enabled. |
| `zccache-daemon-log` | Path to the managed zccache daemon log. |
| `zccache-session-log` | Path to the managed zccache session log. |
| `zccache-journal-log` | Path to the managed zccache structured session journal. |
| `toolchain` | Exact Rust toolchain channel configured for the action. |

### Diagnostic And Compatibility Outputs

| Output | Meaning |
|---|---|
| `build-cache-hit` | Whether the Soldr-owned zccache compilation cache was restored. Empty only when `build-cache` is disabled. |
| `build-cache-key` | Primary key used for the Soldr-owned zccache compilation cache. |
| `build-cache-path` | Soldr-owned zccache compilation cache path. |
| `build-cache-restore-status` | Diagnostic restore status for the Soldr-owned zccache compilation cache. |
| `target-cache-hit` | Whether the zccache-owned Rust artifact cache state was restored. |
| `target-cache-key` | Primary key used for the zccache-owned Rust artifact cache state. |
| `target-cache-paths` | Path passed to `actions/cache` for zccache-owned Rust artifact cache state. |
| `target-cache-mode` | Effective Rust target artifact cache mode. |
| `target-cache-restore-status` | Diagnostic restore status for the Rust target artifact cache state. |

## Notes

- The action installs exactly one released `soldr` binary for the active runner target, defaulting to Soldr `0.7.10`.
- The normal path provisions Rust with `rustup`, bootstrapping `rustup` when it is absent.
- Toolchain-file `components` and `targets` are installed during setup so later `cargo`/`soldr cargo` steps do not trigger rustup lazy installs.
- The action rehydrates the Soldr setup root and uses the runner's existing Cargo/rustup homes unless `CARGO_HOME` or `RUSTUP_HOME` are already set by the workflow.
- The action restores Soldr/zccache cache state by default so child branches can reuse parent-branch build state.
- The default `build-cache-mode` is `thin`, which asks soldr to generate a bounded dependency-artifact plan and lets zccache restore/save the artifacts and report stats. Use `build-cache-mode: full` only for tightly scoped jobs where the whole target directory is known to stay bounded.
- zccache is the artifact cache authority; soldr interprets the Rust build and passes zccache a structured Rust artifact plan.
- `verbose: true` appends zccache trace filters to `RUST_LOG`, keeps the managed daemon log and session log paths stable, and makes downstream `soldr ...` invocations dump newly-written zccache log content after each command.
- Inspect `soldr cache`, zccache session stats, and the setup step's restore-status outputs when warm cache reuse is unexpectedly low.
- The setup cache intentionally keeps Soldr-managed state so the managed zccache binary does not need to be rebuilt on every run.

## Development

Regenerate this repository bundle from the source repository with the exporter in `zackees/soldr`.
