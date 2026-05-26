"""Contract tests for the cache-mode benchmark workflow."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "bench-cache-modes.yml"


def _load_workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _workflow_dispatch_inputs(workflow: dict) -> dict:
    # PyYAML 1.1 treats the key "on" as a bool unless quoted.
    triggers = workflow.get("on") or workflow.get(True)
    return triggers["workflow_dispatch"]["inputs"]


def test_benchmark_workflow_exposes_bounded_dispatch_inputs() -> None:
    workflow = _load_workflow()
    inputs = _workflow_dispatch_inputs(workflow)

    assert "cell_timeout_minutes" in inputs
    assert inputs["cell_timeout_minutes"]["default"] == "30"
    assert "cook-production" in inputs["layers"]["default"]
    assert "cook-production" in inputs["layers"]["description"]


def test_benchmark_cells_timeout_and_upload_partial_csvs() -> None:
    workflow = _load_workflow()
    bench_steps = workflow["jobs"]["bench"]["steps"]

    run_cell = next(step for step in bench_steps if step.get("name") == "Run bench cell")
    assert run_cell["timeout-minutes"] == "${{ fromJSON(inputs.cell_timeout_minutes) }}"
    assert "--cache-backend=local-tar-zstd" in run_cell["run"]
    assert "--compression-model=zstd-19-long27" in run_cell["run"]

    upload = next(step for step in bench_steps if step.get("uses") == "actions/upload-artifact@v4")
    assert upload["if"] == "always()"
    assert upload["with"]["if-no-files-found"] == "warn"


def test_all_on_captures_toolchain_baseline_for_delta_only_payload() -> None:
    workflow = _load_workflow()
    bench_steps = workflow["jobs"]["bench"]["steps"]

    capture = next(step for step in bench_steps if step.get("name") == "Capture pre-soldr toolchain snapshot")
    assert "matrix.layer == 'all-on'" in capture["if"]
