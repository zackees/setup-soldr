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
ARM Linux musl has no mandatory native execution and remains explicitly blocked;
full coverage must refuse that missing cell. This bootstrap does not prove job
connection, matrix execution, native compatibility, security/protection, Bosn or
whole-event cost. Later activation needs its own review and live evidence.

Local gate:

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --offline --no-project --with pytest pytest -q -p no:cacheprovider tests/test_policy_bootstrap.py
```

Independently review before push, require existing CI before merge, and never
promote v0 from bootstrap success alone.
