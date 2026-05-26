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
    assert inputs["cache_backend"]["default"] == "local-tar-zstd"
    assert "local-tar-zstd+actions-cache-smoke" in inputs["cache_backend"]["options"]
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


def test_real_cache_smoke_backend_is_opt_in_and_collated() -> None:
    workflow = _load_workflow()
    save_job = workflow["jobs"]["real-cache-save"]
    restore_job = workflow["jobs"]["real-cache-restore"]

    assert save_job["if"] == "${{ inputs.cache_backend == 'local-tar-zstd+actions-cache-smoke' }}"
    assert restore_job["needs"] == "real-cache-save"
    save_step = next(step for step in save_job["steps"] if step.get("name") == "Save real target cache")
    save_action = next(step for step in save_job["steps"] if step.get("uses") == "actions/cache/save@v4")
    restore_prepare = next(step for step in restore_job["steps"] if step.get("name") == "Prepare real target cache restore")
    restore_action = next(step for step in restore_job["steps"] if step.get("uses") == "actions/cache/restore@v4")
    restore_step = next(step for step in restore_job["steps"] if step.get("name") == "Emit real target cache row")
    assert "scripts/bench-real-cache-smoke.mjs" in save_step["run"]
    assert "--mode=save" in save_step["run"]
    assert save_action["with"]["path"] == "${{ steps.real-save-prepare.outputs.path }}"
    assert save_action["with"]["key"] == "${{ steps.real-save-prepare.outputs.key }}"
    assert "--mode=prepare-restore" in restore_prepare["run"]
    assert restore_action["with"]["path"] == "${{ steps.real-restore-prepare.outputs.path }}"
    assert restore_action["with"]["key"] == "${{ steps.real-restore-prepare.outputs.key }}"
    assert restore_action["with"]["fail-on-cache-miss"] is True
    assert "scripts/bench-real-cache-smoke.mjs" in restore_step["run"]
    assert "--mode=restore" in restore_step["run"]

    collate_needs = workflow["jobs"]["collate"]["needs"]
    assert "bench" in collate_needs
    assert "real-cache-restore" in collate_needs
