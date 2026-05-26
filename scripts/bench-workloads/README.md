# bench-workloads

Rust crates used by `.github/workflows/bench-cache-modes.yml` and `scripts/bench-cache-cell.mjs` to give every cache layer a realistic load to chew through.

| Workload | Goal | Cold build budget |
|---|---|---|
| `demo-small` | tiny — `serde`, `clap`, `anyhow`, `serde_json`. Exercises registry + zccache without dragging cold-build past ~60 s. | < 60 s |

Add new workloads by dropping another directory here and extending the `workload` choice list in the workflow. `Cargo.lock` is **not** checked in — the benchmark intentionally resolves fresh on each cold run so that registry-cache invalidation behaviour is observable.

For build-affecting cache layers, the benchmark wipes `target/` between cold and warm phases so warm results come from the restored cache layer, not leftover workspace state. The `cook` layer snapshots `target/release/deps`; the `target` layer snapshots the whole `target/` tree.
