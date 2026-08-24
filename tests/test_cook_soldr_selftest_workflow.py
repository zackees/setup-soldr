"""Guards for the soldr cook self-test workflow.

The workflow's whole value is that it passes NO cook inputs: it exercises the
shipped defaults against a real workspace. A well-meaning edit that pins
`prebuild-deps: soldr-cook` there would keep the workflow green while
destroying what it tests, so that absence is asserted here rather than left to
review.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).parents[1]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "cook-soldr-selftest.yml"
ACTION = REPO_ROOT / "action.yml"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def test_cook_is_on_by_default_in_the_action() -> None:
    """The property the workflow exists to protect, asserted at the source."""
    action = yaml.safe_load(ACTION.read_text(encoding="utf-8"))
    assert action["inputs"]["prebuild-deps"]["default"] == "soldr-cook"
    assert action["inputs"]["prebuild-deps-delta-cache"]["default"] == "true"


def test_cold_cook_is_serialized_to_fit_hosted_runner_memory() -> None:
    workflow = _workflow()
    assert workflow["env"]["CARGO_BUILD_JOBS"] == "1"
    assert workflow["env"]["SOLDR_JOBS"] == "1"


def test_the_selftest_pins_no_cook_inputs() -> None:
    workflow = _workflow()
    for job_name, job in workflow["jobs"].items():
        for step in job["steps"]:
            if step.get("uses") != "./":
                continue
            pinned = sorted(k for k in (step.get("with") or {}) if "prebuild" in k)
            assert not pinned, (
                f"{job_name} pins {pinned}; this workflow must exercise the "
                "shipped defaults, not restate them"
            )


def test_both_jobs_default_to_linux_and_allow_dispatch_elsewhere() -> None:
    workflow = _workflow()
    for job in workflow["jobs"].values():
        assert "ubuntu-24.04" in str(job["runs-on"])
        assert "inputs.runner" in str(job["runs-on"])

    # `on` is parsed by PyYAML as the boolean True.
    triggers = workflow.get("on", workflow.get(True))
    options = triggers["workflow_dispatch"]["inputs"]["runner"]["options"]
    assert {"windows-2022", "macos-14"} <= set(options)


def test_the_warm_job_refuses_to_assert_without_a_restore() -> None:
    """A freshness assertion after a cache miss proves nothing."""
    warm = _workflow()["jobs"]["warm"]
    guard = next(s for s in warm["steps"] if "restored" in s.get("name", ""))
    assert 'COOK_HIT" != "true"' in guard["run"]

    build = next(s for s in warm["steps"] if s.get("id") == "build")
    assert "assert_no_external_rebuild.py" in build["run"]
    assert "cargo metadata --locked --format-version=1" in build["run"]
    assert '"$RUNNER_TEMP/warm-metadata.json"' in build["run"]
