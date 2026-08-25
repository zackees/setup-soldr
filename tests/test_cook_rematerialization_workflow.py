from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/cook-rematerialization.yml"


def _load() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _step(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


def test_rematerialization_workflow_has_isolated_baseline_seed_delta_and_warm_jobs() -> None:
    workflow = _load()
    jobs = workflow["jobs"]
    assert set(jobs) == {"baseline", "seed", "delta-seed", "warm"}
    assert jobs["delta-seed"]["needs"] == "seed"
    assert jobs["warm"]["needs"] == ["baseline", "delta-seed"]
    assert "github.run_attempt" in workflow["env"]["CACHE_GENERATION"]
    for job in jobs.values():
        checkout = job["steps"][0]
        assert checkout["uses"] == "actions/checkout@v4"
        assert checkout["with"]["submodules"] == "recursive"


def test_seed_and_warm_use_pinned_source_and_only_dependency_closure_caches() -> None:
    workflow = _load()
    for job_name in ("seed", "delta-seed", "warm"):
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


def test_cold_cook_is_serialized_to_fit_hosted_runner_memory() -> None:
    workflow = _load()
    assert workflow["env"]["CARGO_BUILD_JOBS"] == "1"
    assert workflow["env"]["SOLDR_JOBS"] == "1"


def test_warm_gate_requires_usable_transports_and_zero_external_work() -> None:
    workflow = _load()
    warm = workflow["jobs"]["warm"]
    transport = _step(warm, "Require usable dependency-closure transports")
    assert "cook-cache-hit" in transport["env"]["COOK_HIT"]
    assert "cook-cache-base-hit" in transport["env"]["BASE_HIT"]
    assert "cook-cache-delta-hit" in transport["env"]["DELTA_HIT"]
    assert "cargo-registry-cache-hit" in transport["env"]["REGISTRY_HIT"]
    assert 'test "$COOK_HIT" = true' in transport["run"]
    assert 'test "$BASE_HIT" = true' in transport["run"]
    assert 'test "$DELTA_HIT" = false' in transport["run"]
    assert 'test "$REGISTRY_HIT" = true' in transport["run"]
    assert 'test "$COOK_STATUS" = base-hit' in transport["run"]
    assert 'report["delta"]["cacheFilesRestored"] == 0' in transport["run"]
    seed = _step(workflow["jobs"]["seed"], "Record seed transport state")
    assert 'test "$COOK_HIT" = false' in seed["run"]
    assert 'test "$REGISTRY_HIT" = false' in seed["run"]

    build = _step(warm, "Prove only workspace code rebuilds")
    script = build["run"]
    assert "soldr cargo build" in script
    assert "ZCCACHE_DISABLE" not in script
    baseline = _step(workflow["jobs"]["baseline"], "Measure clean dependency build")
    assert "soldr cargo build" in baseline["run"]
    assert "ZCCACHE_DISABLE" not in baseline["run"]
    assert "--message-format=json-render-diagnostics" in script
    assert "assert_warm.py" in script
    # setup-soldr's own copy, not the soldr submodule's. The Contract Tests
    # job checks out without submodules, so reading through _vender/soldr
    # raises FileNotFoundError in CI while passing locally against a populated
    # submodule -- a test that only fails where nobody is looking.
    assertion_source = (
        REPO_ROOT / "tests/cook-rematerialization/assert_warm.py"
    ).read_text(encoding="utf-8")
    assert 'if report["external_dirty"]' in assertion_source
    assert 'if report["external_build_script_runs"]' in assertion_source
    assert '"speedup":' in assertion_source
    assert "warm_ms * 10" not in assertion_source
