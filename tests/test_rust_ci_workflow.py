"""Contract tests for the reusable Rust CI workflow."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "rust-ci.yml"
README_PATH = REPO_ROOT / "README.md"
DEFAULT_CROSS_TARGET = "x86_64-unknown-linux-musl"


def _load_workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _triggers(workflow: dict) -> dict:
    # PyYAML 1.1 treats the key "on" as a bool unless quoted.
    return workflow.get("on") or workflow.get(True)


def _step_named(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


def test_rust_ci_is_cross_first_for_reusable_and_manual_runs() -> None:
    workflow = _load_workflow()
    triggers = _triggers(workflow)

    call_inputs = triggers["workflow_call"]["inputs"]
    assert call_inputs["compile-mode"]["default"] == "cross"
    assert call_inputs["target"]["default"] == DEFAULT_CROSS_TARGET
    assert call_inputs["working-directory"]["default"] == "."
    assert call_inputs["compile-mode"]["type"] == "string"

    dispatch_inputs = triggers["workflow_dispatch"]["inputs"]
    assert dispatch_inputs["compile-mode"]["default"] == "cross"
    assert dispatch_inputs["compile-mode"]["type"] == "choice"
    assert dispatch_inputs["compile-mode"]["options"] == ["cross", "native"]
    assert dispatch_inputs["target"]["default"] == DEFAULT_CROSS_TARGET
    assert dispatch_inputs["working-directory"]["default"] == "scripts/bench-workloads/demo-small"


def test_warm_job_resolves_cross_and_native_modes_once() -> None:
    workflow = _load_workflow()
    warm = workflow["jobs"]["warm"]

    assert warm["outputs"]["target"] == "${{ steps.mode.outputs.target }}"
    assert warm["outputs"]["cross_targets"] == "${{ steps.mode.outputs.cross_targets }}"

    resolve = _step_named(warm, "Resolve compilation mode")
    script = resolve["run"]
    assert 'mode="${{ inputs.compile-mode }}"' in script
    assert 'target="${{ inputs.target }}"' in script
    assert "mode=\"cross\"" in script
    assert f'target="{DEFAULT_CROSS_TARGET}"' in script
    assert "cross_targets=$target" in script
    assert "native)" in script
    assert "compile-mode must be 'cross' or 'native'" in script


def test_targeted_jobs_use_setup_soldr_cross_targets_output() -> None:
    workflow = _load_workflow()

    warm_setup = _step_named(workflow["jobs"]["warm"], "Setup soldr")
    assert warm_setup["id"] == "setup"
    assert warm_setup["with"]["cross-targets"] == "${{ steps.mode.outputs.cross_targets }}"

    for job_name, step_name in (
        ("warm", "Warm build (workspace, all-targets)"),
        ("lint", "cargo check"),
        ("clippy", "cargo clippy"),
        ("test", "cargo test"),
    ):
        job = workflow["jobs"][job_name]
        if job_name != "warm":
            setup = _step_named(job, "Setup soldr")
            assert setup["id"] == "setup"
            assert setup["with"]["cross-targets"] == "${{ needs.warm.outputs.cross_targets }}"

        run_step = _step_named(job, step_name)
        assert run_step["working-directory"] == "${{ inputs.working-directory }}"
        target_expr = "steps.mode.outputs.target" if job_name == "warm" else "needs.warm.outputs.target"
        assert f'target="${{{{ {target_expr} }}}}"' in run_step["run"]
        assert 'args+=(--target "$target")' in run_step["run"]


def test_rust_ci_ensures_targets_through_soldr_toolchain() -> None:
    workflow = _load_workflow()

    expected_targets = {
        "warm": "steps.mode.outputs.target",
        "lint": "needs.warm.outputs.target",
        "clippy": "needs.warm.outputs.target",
        "test": "needs.warm.outputs.target",
    }
    for job_name, target_expr in expected_targets.items():
        ensure = _step_named(workflow["jobs"][job_name], "Ensure rust-ci toolchain extras")
        script = ensure["run"]
        assert "args=(toolchain ensure --json" in script
        assert 'channel="${{ steps.setup.outputs.toolchain }}"' in script
        assert f'target="${{{{ {target_expr} }}}}"' in script
        assert 'args+=(--target "$target")' in script
        assert 'soldr "${args[@]}"' in script

    warm_script = _step_named(workflow["jobs"]["warm"], "Ensure rust-ci toolchain extras")["run"]
    assert "args+=(--component rustfmt)" in warm_script
    assert "args+=(--component clippy)" in warm_script
    assert '${{ inputs.fmt }}' in warm_script
    assert '${{ inputs.clippy }}' in warm_script

    fmt_script = _step_named(workflow["jobs"]["fmt"], "Ensure rust-ci toolchain extras")["run"]
    assert "args+=(--component rustfmt)" in fmt_script

    clippy_script = _step_named(workflow["jobs"]["clippy"], "Ensure rust-ci toolchain extras")["run"]
    assert "toolchain ensure --json --component clippy" in clippy_script


def test_native_mode_preserves_host_target_behavior() -> None:
    workflow = _load_workflow()
    resolve_script = _step_named(workflow["jobs"]["warm"], "Resolve compilation mode")["run"]

    native_branch = resolve_script.split("native)", 1)[1].split(";;", 1)[0]
    assert 'echo "target=" >> "$GITHUB_OUTPUT"' in native_branch
    assert 'echo "cross_targets=" >> "$GITHUB_OUTPUT"' in native_branch


def test_rust_ci_workflow_does_not_directly_install_cross_tooling() -> None:
    text = WORKFLOW_PATH.read_text(encoding="utf-8")
    tool = "car" + "go"

    assert "rustup target add" not in text
    assert f"{tool} zigbuild" not in text
    assert f"{tool}-xwin" not in text


def test_readme_documents_cross_default_native_opt_in_and_manual_trigger() -> None:
    readme = README_PATH.read_text(encoding="utf-8")

    assert "The reusable workflow is cross-compilation-first." in readme
    assert "`compile-mode: cross`" in readme
    assert "`compile-mode: native`" in readme
    assert "`workflow_dispatch`" in readme
    assert "`soldr toolchain ensure --json --target <target>`" in readme
    assert DEFAULT_CROSS_TARGET in readme
