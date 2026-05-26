# bench-workloads

Rust crates used by `.github/workflows/bench-cache-modes.yml` and
`scripts/bench-cache-cell.mjs` to give every cache layer a realistic load to
chew through.

| Workload | Goal | Cold build budget |
|---|---|---|
| `demo-small` | tiny - `serde`, `clap`, `anyhow`, `serde_json`. Exercises registry + zccache without dragging cold-build past ~60 s. | < 60 s |

Add new workloads by dropping another directory here and extending the
`workload` choice list in the workflow. `Cargo.lock` is not checked in: the
benchmark intentionally resolves fresh on each cold run so registry-cache
invalidation behavior is observable.

For build-affecting cache layers, the benchmark wipes `target/` between cold
and warm phases so warm results come from the restored cache layer, not leftover
workspace state. The `cook` layer snapshots the deps-only slice at
`target/release/deps`; `cook-production` snapshots the production-shaped whole
`target/` directory after the cold build; and `target` snapshots the whole
`target/` tree as the fallback warm path.

The benchmark CSV labels its archive model. Rows with
`cache_backend=local-tar-zstd` and `compression_model=zstd-19-long27` are
synthetic local archive timings, not direct GitHub Actions cache
upload/download timings. The collated summary reports
`break_even_warm_hits` so large save costs are visible even when a warm restore
is fast.
