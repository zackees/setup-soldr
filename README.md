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

## Inputs

| Input | Meaning |
|---|---|
| `version` | Soldr release tag or version to install. Defaults to `0.7.10`. |
| `cache` | Restore and save the action-managed cache/state root. |
| `cache-dir` | Override the runner-local cache/state root. |
| `cache-key-suffix` | Optional escape hatch appended to the cache key. |
| `toolchain` | Explicit Rust toolchain channel override. |
| `toolchain-file` | Alternate toolchain file path when `toolchain` is empty; `components` and `targets` in the file are provisioned during setup. |
| `trust-mode` | Optional `SOLDR_TRUST_MODE` value. |
| `timestamps` | Prefix setup-soldr diagnostics and streamed command output with elapsed `mm:ss` timestamps. Default `true`; set to `false` to opt out. |
| `lockfile` | Optional `Cargo.lock` path used for Rust artifact cache keying. Empty infers `Cargo.lock` next to `target-dir`, then workspace `Cargo.lock`. |
| `build-cache` | Restore and save Soldr/zccache build cache state across runs. Default `true`; set to `false` to opt out. |
| `build-cache-mode` | Rust build cache mode. Default `once` saves a full snapshot on miss, then restores without resaving on later hits. `thin` is the bounded dependency-artifact alternative. `full` opts into normal whole-target restore/save behavior and should be treated as unbounded. |
| `target-dir` | Cargo target directory used by soldr when constructing the Rust artifact cache plan. |

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
| `build-cache-hit` | Whether the Soldr-owned zccache compilation cache was restored. Empty only when `build-cache` is disabled. |
| `build-cache-key` | Primary key used for the Soldr-owned zccache compilation cache. |
| `build-cache-path` | Soldr-owned zccache compilation cache path. |
| `build-cache-mode` | Effective setup-soldr Rust build cache mode. |
| `build-cache-restore-status` | Diagnostic restore status for the Soldr-owned zccache compilation cache. |
| `target-cache-hit` | Whether the zccache-owned Rust artifact cache state was restored. |
| `target-cache-key` | Primary key used for the zccache-owned Rust artifact cache state. |
| `target-cache-path` | Cargo target directory used by soldr for Rust artifact planning. |
| `target-cache-paths` | Path passed to `actions/cache` for zccache-owned Rust artifact cache state. |
| `target-cache-mode` | Effective setup-soldr Rust target artifact cache mode. |
| `target-cache-restore-status` | Diagnostic restore status for the Rust target artifact cache state. |
| `target-lockfile` | `Cargo.lock` path used for Rust artifact cache keying. |
| `target-lockfile-hash` | Short hash of the `Cargo.lock` used for Rust artifact cache keying, or `no-lock`. |
| `toolchain` | Exact Rust toolchain channel configured for the action. |

## Notes

- The action installs exactly one released `soldr` binary for the active runner target, defaulting to Soldr `0.7.10`.
- The normal path provisions Rust with `rustup`, bootstrapping `rustup` when it is absent.
- Toolchain-file `components` and `targets` are installed during setup so later `cargo`/`soldr cargo` steps do not trigger rustup lazy installs.
- The action rehydrates the Soldr setup root and uses the runner's existing Cargo/rustup homes unless `CARGO_HOME` or `RUSTUP_HOME` are already set by the workflow.
- The action restores Soldr/zccache cache state by default so child branches can reuse parent-branch build state.
- The default `build-cache-mode` is `once`, which maps to soldr/zccache full-target planning on a cold run but switches restored sessions to restore-only cache rehydration. Use `build-cache-mode: thin` for the bounded dependency-artifact alternative, or `build-cache-mode: full` when you explicitly want normal whole-target restore/save behavior on every run.
- zccache is the artifact cache authority; soldr interprets the Rust build and passes zccache a structured Rust artifact plan.
- Inspect `soldr cache`, zccache session stats, and the setup step's restore-status outputs when warm cache reuse is unexpectedly low.
- The setup cache intentionally keeps Soldr-managed state so the managed zccache binary does not need to be rebuilt on every run.

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
