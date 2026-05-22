# setup-soldr — Claude instructions

## Change workflow

All changes land via a feature branch and PR — never commit directly to `main`. Merge to `main` only after CI passes (the PR is the unit of "on success"). This matches the repo's history of numbered bump/feature PRs (e.g. `#128`).

Floating major tags (e.g. `v0`) are moved to point at the new `main` commit only after the PR is merged, then pushed.
