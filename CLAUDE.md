# setup-soldr — Claude instructions

## Change workflow

All changes land via a feature branch and PR — never commit directly to `main`. Merge to `main` only after CI passes (the PR is the unit of "on success"). This matches the repo's history of numbered bump/feature PRs (e.g. `#128`).

Floating major tags (e.g. `v0`) are moved to point at the new `main` commit only after the PR is merged, then pushed.

## Cache and toolchain optimization principles

Durable design rules for fast-pathing the install of soldr, rustup, the Rust toolchain, components, targets, and any tool soldr fetches. These apply when adding new cache layers or modifying existing ones (`src/main.ts`, `src/post.ts`, `src/lib/cache-compress.ts`, `src/lib/ensure-rust-toolchain.ts`, `src/lib/ensure-soldr.ts`).

### Layer per change cadence

Build separate cache layers, each keyed by its own invalidation triggers. Conflating cadences kills hit rate.

| Layer | Cadence | Key on |
|---|---|---|
| soldr binary | per soldr release | `version` + platform |
| Rust toolchain + components + targets | per rustc release / per components change | exact `rustc_release` + sorted hashes |
| Project deps (`soldr cook` output) | per `Cargo.lock` change | lockfile hash |
| Build cache (zccache state) | per source compile | content-driven |
| Target cache | per build | content-driven |

A new cache layer must justify its ~200–500 ms per-run cache-API roundtrip. Don't add layers that only help fringe cases — the always-paid lookup tax outweighs the conditional win.

### Detect-then-cache: only save the delta

Before saving a cache, snapshot what the runner image already provides; cache only what setup-soldr added on top.

- GitHub-hosted runners ship rustup + a current stable toolchain (`/usr/share/rust/` on Linux, user profile on macOS/Windows). Default-stable workflows should produce **zero cache writes**.
- `ensureRustupAvailable` (`src/lib/ensure-rust-toolchain.ts:50`) already short-circuits on PATH-resident rustup. Extend the same discipline per-component, per-target, per-exact-release.
- Snapshot `$RUSTUP_HOME/toolchains/` + `$CARGO_HOME/bin/` before our work; diff after; tar only the added paths. Wrong shape: snapshot the whole `RUSTUP_HOME` and pay for re-shipping what the runner already had.

### Coarse keys, shared across workflows

Cache keys live in the *(layer, platform, version-of-what-the-layer-tracks)* space — never mixed with workflow filename, branch, or `cache-key-suffix`. One repo with N workflows using the same toolchain should hit the same cache entry. LRU access pattern dominates eviction risk for small entries; coarse keys keep entries warm.

### Floating channels must resolve to exact release before keying

`stable`/`beta`/`nightly` resolve to a specific rustc release. Resolve that **before** building the cache key:

```
GET https://static.rust-lang.org/dist/channel-rust-${channel}.toml
→ pkg.rust.version = "1.84.1 (abc1234 2026-05-12)"
```

Key on `rustc_release` (`1.84.1`), not on `channel` (`stable`). Wrong shape:
- Key on `stable` literally → never invalidates when upstream ships a patch → serves stale toolchains.
- Don't resolve → every run looks like a miss → no warm path at all.

After restoring, run `rustc --version` against the restored `$RUSTUP_HOME` and verify it matches expected. Cheap insurance against corrupt cache entries.

### Restore-key fallback ladder

A small toolchain delta should not force a full reinstall. Order fallbacks from most-specific to least, never dropping safety dimensions:

1. exact: `prep-${os}-${arch}-${libc}-rustc${release}-c${cHash}-t${tHash}-soldr${sver}`
2. drop targets: restore + `rustup target add <missing>` (~seconds per target)
3. drop components: restore + `rustup component add <missing>` (~seconds per component)
4. drop soldr: restore + re-fetch soldr binary (~2 s)

**Never** drop `release`, `arch`, `os`, or `libc` from the key. A wrong-host toolchain is silent breakage, not a slow build.

### libc axis (glibc vs musl)

Keep `libc` in the cache key, accept two entries per repo when the matrix actually mixes them. Cross-libc sharing is mostly not worth the plumbing:

- **Host binaries** (`rustc`, `cargo`, `rustfmt`, `clippy`, `rustup`) link against the runner's libc — cannot be shared.
- **Target-side artifacts** (`rust-std-<target>`, manifest metadata) are byte-identical across libc, ~30–60 MB out of ~300–400 MB total. Two-layer split to share that slice is more complexity than it's worth unless the CI matrix routinely mixes glibc and musl hosts.

Reality check on the hosted-runner matrix: `ubuntu-*` and `ubuntu-*-arm` are glibc, `macos-*` and `windows-*` have no libc axis at all. Self-hosted Alpine is the only practical musl case.

### Compression: zstd -19 with `--long=27` for toolchain content

- Default `cache-compress.ts` level is 3. For long-lived caches (save once, restore N times) bump to **-19** — ~45 % smaller than gzip-6, restore time is constant.
- `-22` (ultra) shaves ~3 MB more for 3× save time. Not worth it.
- Add `--long=27` (128 MB window) for toolchain content — internal redundancy across crates that a small window misses. Another ~5–8 % off.
- Compression knob is already wired through `parseLevel` (`src/lib/cache-compress.ts:243`). Each layer should own its own level — solo-cache at -19, target-cache at its existing default.

### Runner-image reality for decompression

| Runner | `zstd` CLI | `tar --zstd` | Practical state |
|---|---|---|---|
| `ubuntu-*` | preinstalled | tar 1.34+ | works |
| `macos-*` | preinstalled | gnutar via Homebrew | works |
| `windows-*` | often missing | bsdtar 3.6+ ships with Windows | works via tar |
| Alpine / busybox containers | missing | busybox tar lacks `--zstd` | needs `apk add zstd` in image |

`src/lib/cache-compress.ts:144–156` already implements the `io.which("zstd") ?? tar --zstd` fallback. Mirror that pattern in any new install-side decompression (e.g., zstd-compressed soldr release assets).

### Vendor vs cache vs fetch decision

When a tool needs to be on the runner *before* any cache layer can do work (e.g., `zstd` itself), don't try to put it in a cache — bootstrap paradox kills it (a zstd-compressed cache holding zstd is unreachable). Three options, pick by size and version-coupling:

| Approach | Best for | Cost |
|---|---|---|
| **Vendor** (committed under `vendor/<tool>/<triple>/`) | tiny + stable + bootstrap-needed (e.g. `zstd`, <~3 MB across all platforms) | one-time action-checkout size; near-zero wire after gzip |
| **Cache** (Actions Cache layer) | medium size + version-coupled + frequently reused (Rust toolchain, deps) | ~200–500 ms lookup; LRU eviction risk |
| **Fetch on demand** (HTTPS to GH Releases / static.rust-lang.org) | large or rarely reused | full download every miss |

Decision boundary: ~5 MB per platform. Above that, vendoring inflates every action checkout and you should fetch + cache instead.

Vendor layout (when adopted):
```
vendor/
  <tool>/
    linux-x64/<tool>
    linux-arm64/<tool>
    macos-x64/<tool>
    macos-arm64/<tool>
    windows-x64/<tool>.exe
    windows-arm64/<tool>.exe
    VERSION.json   # upstream, version, sha256 per triple
    LICENSE        # carried from upstream
```

Vendor bumps go through a maintainer-run `scripts/sync-vendor.mjs` that hash-verifies against `VERSION.json`. Don't auto-update vendor on CI — each bump is a reviewable PR.

### Release format and cache format are independent

What soldr (or any upstream) ships on GitHub Releases is a separate decision from what setup-soldr stores in its cache. The cache layer can always recompress to whatever's optimal:

- Release as `.tar.gz` → setup-soldr cache as `.tar.zst -19` (decouples non-CI consumers from zstd requirements).
- Release as `.tar.zst` → setup-soldr cache same → decompression unified through `cache-compress.ts` magic-byte sniff.

Don't bundle non-CI consumers (Docker, manual install, `cargo install`) into a specific decompressor just to optimize the CI cache path.

### Cache-lifetime axis: build the foundation first

Cache layers live on two independent axes — **size** and **lifetime** (how often the key invalidates). Designs that ignore the lifetime axis end up shipping the wrong layer first.

```
              SHORT-LIVED                     LONG-LIVED
            (churns on edit)                (churns on release)
SMALL   ┌─────────────────────────┬─────────────────────────┐
        │ source-mtime sidecar    │ soldr-mini-cache        │
        │ compile-journal         │ vendored zstd           │
        │                         │ toolchain solo-cache    │
        ├─────────────────────────┼─────────────────────────┤
LARGE   │ target-cache            │ (rare — most large      │
        │ build-cache (zccache)   │  artifacts churn fast)  │
        │ soldr cook output       │                         │
        └─────────────────────────┴─────────────────────────┘
```

**Foundation layers live in the long-lived/small quadrant.** They're cheap, hit rate is near-100%, and they form the baseline every subsequent run can assume. Build these first because:

- **They don't depend on heavier layers.** Toolchain solo-cache works whether or not cook is wired in. Cook *needs* a toolchain — without the foundation the heavy layer pays bootstrap cost every cold run, blurring whatever signal it produces.
- **Measurement is cleaner once the floor exists.** Time a cook-cache hit vs miss against a workflow that already has the foundation, and the deps-compile delta is the only thing moving. Without the foundation, you're measuring `foundation_bootstrap + cook_delta` and can't separate them.
- **LRU pressure goes the right way.** GitHub Actions Cache is 10 GB per repo with LRU eviction. Small + frequently-hit entries keep their access timestamp warm and survive eviction trivially. Large + short-lived entries (cook tarballs, target trees) compete hard for the same budget — if a heavy layer drives out the foundation, the next cold run pays *both* costs.
- **Foundation layers don't need users to keep `Cargo.lock` stable** to deliver value. Heavy layers do.

**Anti-pattern**: shipping the biggest absolute win first (cook) without the foundation. The cook tarball is multi-GB and invalidates on any dep update, so its hit rate is workload-dependent. On a repo with active dep churn, cook misses most of the time and pays full cold-deps cost on every miss — *plus* whatever toolchain bootstrap the missing foundation didn't shave off. The combined cold-cold case is slower than a foundation-only setup.

**Rule**: when adding a new cache layer, place it on the size × lifetime grid first. If it lands in the short-lived/large quadrant, the foundation in the long-lived/small quadrant must be in place — otherwise you're optimizing the wrong floor.

### Prioritization framework for fast-path work

When ranking optimizations, two axes matter:

1. **Magnitude**: how many seconds/MB per run does it save?
2. **Universality**: every run vs conditional?

A 60-second win that fires every run beats a 600-second win that fires once a week. Order roughly by `seconds_saved × probability_of_firing`. Settled order at time of writing:

1. **Prepare/toolchain solo-cache** — every run pays the toolchain bootstrap, ~45–90 s savings, no upstream dependency. Do first.
2. **`soldr cook` integration** (setup-soldr#110) — 5–15 min savings on cold deps but only when `Cargo.lock` is stable. Bigger absolute win, lower hit rate. Do second.
3. **soldr-mini-cache** (binary-only, ~2 MB, keyed on version+platform) — small absolute win (~2 s) but near-100 % hit rate per version. Cheap to add alongside the toolchain solo-cache.
4. **Vendored `zstd`** — eliminates a fallback branch, gives container/self-hosted parity. Trivial, no urgency.

### What to verify before writing cache code

Cache code is famously easy to write and famously hard to validate. Before landing a new cache layer:

1. Measure the **no-op case** (vanilla `ubuntu-latest`, `channel: stable`, no extras). The new layer should produce **zero cache writes**. If it doesn't, the snapshot/diff logic is wrong.
2. Measure the **typical pinned case** (specific channel, one extra target). Confirm only the delta lands in the cache, not the runner's pre-existing toolchain.
3. **Cold restore smoke test**: untar the cache into a clean `$RUSTUP_HOME` and run `rustup show` + `rustc --version`. Catches "the cache restored but rustup can't see it" failures.
4. **Stat the archive size** before and after `--long=27`, before and after `-19` — cache stats are diagnostic gold. Pipe through `statsCollector` (`src/lib/stats-collector.ts`) so warm runs surface size drift over time.
