# Changelog

## v0.9.10 - 2026-05-26

- Fixed cache-mode benchmark methodology so the matrix now measures distinct
  build-affecting layers instead of reusing warmed target or zccache state.
- Added runner-image delta measurement for the solo-toolchain benchmark path.
- Verified the repaired default benchmark run:
  <https://github.com/zackees/setup-soldr/actions/runs/26457448768>.

