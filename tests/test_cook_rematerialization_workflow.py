from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/cook-rematerialization.yml"


def _load() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _step(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


def test_rematerialization_workflow_has_isolated_baseline_seed_and_warm_jobs() -> None:
    workflow = _load()
    jobs = workflow["jobs"]
    assert set(jobs) == {"baseline", "seed", "warm"}
    assert jobs["warm"]["needs"] == ["baseline", "seed"]
    for job in jobs.values():
        checkout = job["steps"][0]
        assert checkout["uses"] == "actions/checkout@v4"
        assert checkout["with"]["submodules"] == "recursive"


def test_seed_and_warm_use_pinned_source_and_only_dependency_closure_caches() -> None:
    workflow = _load()
    for job_name in ("seed", "warm"):
        setup = next(
            step for step in workflow["jobs"][job_name]["steps"] if step.get("uses") == "./"
        )
        inputs = setup["with"]
        assert inputs["source-path"] == "_vender/soldr"
        assert inputs["build-cache"] is False
        assert inputs["target-cache"] is False
        assert inputs["cargo-registry-cache"] is True
        assert inputs["solo-toolchain-cache"] is False
        assert inputs["soldr-mini-cache"] is False
        assert inputs["prebuild-deps"] == "soldr-cook"
        assert inputs["prebuild-deps-delta-cache"] is True
        assert inputs["lockfile"].endswith("/Cargo.lock")


def test_warm_gate_requires_transport_hits_zero_external_work_and_ten_x_speedup() -> None:
    workflow = _load()
    warm = workflow["jobs"]["warm"]
    transport = _step(warm, "Require both dependency-closure transports")
    assert "cook-cache-hit" in transport["env"]["COOK_HIT"]
    assert "cargo-registry-cache-hit" in transport["env"]["REGISTRY_HIT"]
    assert 'test "$COOK_HIT" = true' in transport["run"]
    assert 'test "$REGISTRY_HIT" = true' in transport["run"]

    build = _step(warm, "Prove only workspace code rebuilds")
    script = build["run"]
    assert "ZCCACHE_DISABLE=1 soldr cargo build" in script
    assert "--message-format=json-render-diagnostics" in script
    assert "assert_warm.py" in script
    assertion_source = (
        REPO_ROOT
        / "_vender/soldr/ci/cook_rematerialization/assert_warm.py"
    ).read_text(encoding="utf-8")
    assert 'if report["external_dirty"]' in assertion_source
    assert 'if report["external_build_script_runs"]' in assertion_source
    assert "warm_ms * 10 > seed_ms" in assertion_source
