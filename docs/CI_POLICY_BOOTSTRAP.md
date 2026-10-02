# Trusted CI policy bootstrap

This PR deploys declarative policy data only. No workflow activation, action
implementation, cache behavior, required check or manual v0 promotion changes.
Existing baseline workflows do not consume these contracts.

Later activation consumes `ci/fleet-adapter.v1.json` for tier selection and
summary and `ci/fleet-full.v1.json` for full coverage. After independent review,
existing CI success and merge, pin all trusted `.fleet-contract` checkouts to
this PR's exact 40-character merge SHA. Never use candidate-owned contracts or
fall back when trusted files are missing. The separate Soldr helper SHA remains
provisional pending serial acceptance.

Full retains eight supported platform/ABI targets and seven extended job groups.
This policy update requires ARM Linux musl build and native execution through
cross-prepare. The separate activation source must run that required fixture
on ubuntu-24.04-arm without capability skipping. Existing default workflows do
not consume these contracts; this data-only update does not activate that source.
After review, existing CI success and merge, activation must pin the exact merge
SHA before using the revised requirement. The prior d1c0009 bootstrap still
refuses ARM musl because it lacks run_job.

A manifest requirement is not execution evidence. Real hosted ARM musl build,
native fixture output, matrix completeness, security/protection, Bosn and
whole-event cost proof remain pending. Do not claim fleet acceptance or promote
v0 based on this update.

Local gate:

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --offline --no-project --with pytest pytest -q -p no:cacheprovider tests/test_policy_bootstrap.py
```

Independently review before push, require existing CI before merge, and never
promote v0 from bootstrap success alone.
