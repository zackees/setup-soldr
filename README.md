# setup-soldr

[![Setup Soldr Action](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml/badge.svg)](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml)

Public GitHub Action for installing one released `soldr` binary, provisioning the resolved Rust toolchain with `rustup`, and restoring cacheable Soldr/zccache state without rehydrating large Cargo or rustup homes by default.

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
| `version` | Soldr release tag or version to install. Empty means latest release. |
| `cache` | Restore and save the action-managed cache/state root. |
| `cache-dir` | Override the runner-local cache/state root. |
| `cache-key-suffix` | Optional escape hatch appended to the cache key. |
| `toolchain` | Explicit Rust toolchain channel override. |
| `toolchain-file` | Alternate toolchain file path when `toolchain` is empty. |
| `trust-mode` | Optional `SOLDR_TRUST_MODE` value. |
| `timestamps` | Prefix setup-soldr diagnostics and streamed command output with elapsed `mm:ss` timestamps. Default `true`; set to `false` to opt out. |
| `lockfile` | Optional `Cargo.lock` path used for target-cache keying. Empty infers `Cargo.lock` next to `target-dir`, then workspace `Cargo.lock`. |
| `build-cache` | Restore and save the Soldr-owned zccache compilation artifact cache across runs. Default `true`; set to `false` to opt out. |
| `target-cache` | Restore and save Cargo target paths for no-op CI fast paths. Default `false` because Cargo target directories do not garbage collect themselves and can grow to multi-GB caches; enable only with bounded `target-cache-paths`. See [zackees/setup-soldr#21](https://github.com/zackees/setup-soldr/issues/21), [zackees/zccache#65](https://github.com/zackees/zccache/issues/65), and [zackees/soldr#197](https://github.com/zackees/soldr/issues/197). |
| `target-dir` | Cargo target directory restored by `target-cache`. |
| `target-cache-paths` | Optional newline-separated target-cache paths or glob patterns. Defaults to `target-dir` when `target-cache` is enabled; set to a profile subdirectory such as `target/debug` to avoid caching unrelated profiles. |

## Outputs

| Output | Meaning |
|---|---|
| `soldr-path` | Installed Soldr binary path added to `PATH`. |
| `soldr-version` | Installed Soldr version reported by `soldr version --json`. |
| `cache-dir` | Action-managed runner-local cache/state root. |
| `cache-hit` | Whether the action restored an exact cache hit. |
| `cache-key` | Primary key used for the action-managed cache/state root. |
| `cache-restore-status` | Diagnostic restore status for the action-managed cache/state root. |
| `build-cache-hit` | Whether the Soldr-owned zccache compilation cache was restored. Empty only when `build-cache` is disabled. |
| `build-cache-key` | Primary key used for the Soldr-owned zccache compilation cache. |
| `build-cache-path` | Soldr-owned zccache compilation cache path. |
| `build-cache-restore-status` | Diagnostic restore status for the Soldr-owned zccache compilation cache. |
| `target-cache-hit` | Whether the Cargo target directory cache was restored. |
| `target-cache-key` | Primary key used for the Cargo target directory cache. |
| `target-cache-path` | Cargo target directory cache path. |
| `target-cache-paths` | Paths or glob patterns passed to `actions/cache` for target-cache. |
| `target-cache-restore-status` | Diagnostic restore status for the Cargo target directory cache. |
| `target-lockfile` | `Cargo.lock` path used for target-cache keying. |
| `target-lockfile-hash` | Short hash of the `Cargo.lock` used for target-cache keying, or `no-lock`. |
| `toolchain` | Exact Rust toolchain channel configured for the action. |

## Notes

- The action installs exactly one released `soldr` binary for the active runner target.
- The normal path provisions Rust with `rustup`, bootstrapping `rustup` when it is absent.
- The action rehydrates the Soldr setup root and uses the runner's existing Cargo/rustup homes unless `CARGO_HOME` or `RUSTUP_HOME` are already set by the workflow.
- The action restores the Soldr-owned zccache cache root by default so child branches can reuse parent-branch build state.
- Full Cargo target caching is opt-in until target snapshot garbage collection is bounded; prefer the default zccache artifact cache for normal CI.
- The setup cache intentionally keeps Soldr-managed state so the managed zccache binary does not need to be rebuilt on every run.

## Development

Regenerate this repository bundle from the source repository with the exporter in `zackees/soldr`.
