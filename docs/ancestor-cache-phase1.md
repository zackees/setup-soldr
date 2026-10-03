# Ancestor build-cache pilot (setup-soldr #552, ci.yml #185)

This is Phase 1, explicitly opt-in. `key: auto` enables the pilot;
`auto-key: true` enables it when `key` is omitted. An ordinary omitted key
keeps the existing behavior. A nonempty explicit key overrides only the
build-cache key. Toolchain, mini, registry, cook, target and Dylint families
retain their existing identity lookups. Source-independent toolchain entries
have no useful source-DAG distance and incur no new lookup cost.

The pilot uses the source-dependent zccache build-cache family. Phase 0 found
that soldr's archived PR jobs disabled this generic family; its repository-owned
unit-test cache was active. Therefore the inventory cannot establish this
pilot's hit rate. A caller must deliberately enable the generic build cache
before measuring it.

## Identity and selection

New keys contain the strict legacy build identity, lockfile identity, build
mode, target profile, Cargo configuration, workspace manifests and target/flags
environment, hashed together, plus the **actual checked-out** full commit SHA,
writer run ID and attempt. PR-scoped writers add a delimited `pr-<N>` component.

GET-only cache listing considers the current ref, a PR's base ref and the
default branch, filtering the exact identity namespace and ref. Scans stop at
two 100-entry pages per scope, 200 ancestry candidates, 24 GET requests or the
45-second scan budget. Requests have 15-second timeouts; a request already in
flight can extend the wall-clock bound. Local Git subprocesses have 30-second
timeouts. These conservative bounds deliberately favor legacy fallback.

A shallow checkout gets one bounded 200-commit fetch. Parent-edge breadth-first
search ranks candidates by shortest DAG distance. `merge-base --is-ancestor`
confirms local ancestry. Candidates outside the local graph use the compare
API, with at most 199 commits plus the candidate base, and the same parent-edge
ranking. `ahead_by` is insufficient for merge DAG distance. Equal distances
prefer the newest creation time, then cache ID.

Entry presence, a SHA in its key, a successful workflow and even an exactly
matching stdout record are insufficient writer authority. Arbitrary workflow
steps can print public-known JSON and upload a cache outside the post gates.
The bounded Phase 1 pilot therefore requires `auto-key-trusted-writers`, an
explicit policy of reviewed immutable writer jobs, each pinning repository,
workflow path, complete source SHA, run ID, attempt and job ID. The caller must
review the pinned post action and the complete transitive executable source;
pinning an unchanged YAML file alone cannot authenticate changed scripts or
build.rs. This is a trust grant to that particular execution, not a log-based
claim that an arbitrary action origin has been authenticated.

GitHub's authenticated run metadata must match the policy's repository,
head repository, workflow, full source SHA, run and attempt, and the job API
must identify the exact approved successful job. Unknown/unlisted writers
fail closed for automatic selection and use legacy restore. A forged marker
from another successful workflow, source, run, attempt or job cannot qualify.
Without an approved writer the pilot performs no donor API scan. It may still
publish a seed under the ordinary upload gates; its save record becomes
eligible only after explicit immutable-writer review, avoiding a bootstrap
dependency on approving a job that has not run yet.
Within that trusted writer execution, up to 20 ranked candidates also require
a matching positive cache ID/key/ref/SHA/run/attempt save record. Normal
post-phase upload emits that record only after existing
failed-job, delta, dependency-yank and payload/save-policy gates permit a real
positive-ID save. A restored dependency closure with an incomplete or failed
yank audit exits before upload. A cache timestamp must fall inside that job.
Unknown old keys, missing logs, failed donors and negative upload IDs never
qualify for automatic selection. They may still be restored by the unchanged
legacy path when no proven automatic donor is available.

The selected ancestor is restored by exact key. A miss uses the legacy
restore ladder. Existing archive/zero-extraction/decompression guards still
turn unusable payloads into a cold start. Only a same-source exact write-key
hit suppresses publication; an ancestor is merely a build starting point.
Cargo fingerprints continue to decide rebuilds.

## Tradeoffs and measurement plan

Donor logs avoid introducing Phase 2's manifest or another remote writer.
Their lookup/download cost is a deliberate Phase 1 experiment. The job
summary reports the selected key, distance, total scan time and GET count.
Missing or oversized (>32 MiB) logs fail open. There are no payload transfers
between PR scope and main, no promotion, and no default enablement.

Proposed first pilot: a narrowly selected soldr Linux unit-test caller that
actually compiles source, with its existing toolchain floor and required test
coverage preserved. Enable generic `build-cache: true` and `key: auto` on that
caller only; retain the existing save policy and janitor/budget controls.
Confirm new successful default-branch saves first, review and explicitly pin
the immutable main-seed writer jobs in the reader policy, then collect at least 20
executed PR jobs. Record absent jobs separately, and compare identity-compatible
legacy restore versus chosen donor, actual checkout ancestry/distance, cold
compiles, restore/decompress/build wall time, scan time, GET count/rate-limit
headers, save outcome and total cache bytes. A warm restore alone does not
prove avoided compilation. Compare against a matching explicit-key baseline;
Phase 0's disabled generic build-cache observations are not a baseline hit rate.

The immutable job policy is temporary pilot scaffolding. It deliberately does
not authorize every future writer automatically. Final rollout still requires
an automatically authenticated trusted writer boundary, such as a separately
isolated trusted writer with a reviewed immutable executable surface. Do not
infer authenticated post-action origin from a marker, or make the final design
depend on reviewing every future run manually. These changes do not complete
the final auto-ancestor/default requirement.

Do not enable another layer, add a manifest, promote PR payloads, or make auto
the default from these unit tests. Report measured results to both issues;
Phases 2–4 require their own decisions and eventual second-repository evidence.
