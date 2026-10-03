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

    resolve = _step_named(warm, "Resolve compilation mode")
    script = resolve["run"]
    assert 'mode="${{ inputs.compile-mode }}"' in script
    assert 'target="${{ inputs.target }}"' in script
    assert "mode=\"cross\"" in script
    assert f'target="{DEFAULT_CROSS_TARGET}"' in script
    assert "native)" in script
    assert "compile-mode must be 'cross' or 'native'" in script


def test_jobs_pass_generated_toolchain_file_to_setup_soldr() -> None:
    workflow = _load_workflow()

    for job_name in ("warm", "fmt", "lint", "clippy", "test"):
        job = workflow["jobs"][job_name]
        write = _step_named(job, "Write rust-ci toolchain spec")
        assert write["id"] == "toolchain"
        assert 'path="rust-toolchain.rust-ci.toml"' in write["run"]

        setup = _step_named(job, "Setup soldr")
        assert setup["with"]["toolchain-file"] == "${{ steps.toolchain.outputs.path }}"
        assert "toolchain" not in setup["with"]
        target_expr = "steps.mode.outputs.target" if job_name == "warm" else "needs.warm.outputs.target"
        assert setup["with"]["cross-targets"] == f"${{{{ {target_expr} }}}}"
        assert "cross-tool" not in setup["with"]

    for job_name, step_name in (
        ("warm", "Warm build (workspace, all-targets)"),
        ("lint", "cargo check"),
        ("clippy", "cargo clippy"),
        ("test", "cargo test"),
    ):
        job = workflow["jobs"][job_name]
        if job_name != "warm":
            setup = _step_named(job, "Setup soldr")
            assert setup["with"]["toolchain-file"] == "${{ steps.toolchain.outputs.path }}"

        run_step = _step_named(job, step_name)
        assert run_step["working-directory"] == "${{ inputs.working-directory }}"
        target_expr = "steps.mode.outputs.target" if job_name == "warm" else "needs.warm.outputs.target"
        assert f'target="${{{{ {target_expr} }}}}"' in run_step["run"]
        assert 'args+=(--target "$target")' in run_step["run"]


def test_rust_ci_toolchain_specs_request_targets_and_components() -> None:
    workflow = _load_workflow()

    expected_targets = {
        "warm": "steps.mode.outputs.target",
        "fmt": "needs.warm.outputs.target",
        "lint": "needs.warm.outputs.target",
        "clippy": "needs.warm.outputs.target",
        "test": "needs.warm.outputs.target",
    }
    for job_name, target_expr in expected_targets.items():
        write = _step_named(workflow["jobs"][job_name], "Write rust-ci toolchain spec")
        script = write["run"]
        assert 'channel="${{ inputs.toolchain }}"' in script
        assert "channel=\"stable\"" in script
        assert 'sed -n -E' in script
        assert 'echo "[toolchain]"' in script
        assert "profile = \"minimal\"" in script
        assert f'target="${{{{ {target_expr} }}}}"' in script
        assert 'targets = ["%s"]' in script
        assert "components+=(rustfmt)" in script
        assert "components+=(clippy)" in script
        assert '${{ inputs.fmt }}' in script
        assert '${{ inputs.clippy }}' in script


def test_native_mode_preserves_host_target_behavior() -> None:
    workflow = _load_workflow()
    resolve_script = _step_named(workflow["jobs"]["warm"], "Resolve compilation mode")["run"]

    native_branch = resolve_script.split("native)", 1)[1].split(";;", 1)[0]
    assert 'echo "target=" >> "$GITHUB_OUTPUT"' in native_branch


def test_rust_ci_workflow_uses_soldr_target_lifecycle() -> None:
    text = WORKFLOW_PATH.read_text(encoding="utf-8")
    tool = "car" + "go"

    assert "rustup target add" not in text
    assert "toolchain ensure" not in text
    assert "cross-targets:" in text
    assert "soldr build" in text
    assert f"{tool} zigbuild" not in text
    assert f"{tool}-xwin" not in text


def test_readme_documents_cross_default_native_opt_in_and_manual_trigger() -> None:
    readme = README_PATH.read_text(encoding="utf-8")

    assert "The reusable workflow is cross-compilation-first." in readme
    assert "`compile-mode: cross`" in readme
    assert "`compile-mode: native`" in readme
    assert "`workflow_dispatch`" in readme
    assert "`rust-toolchain.rust-ci.toml`" in readme
    assert "`toolchain-file`" in readme
    assert DEFAULT_CROSS_TARGET in readme


# The dispatch experiment must not widen reusable caller permissions or alter
# ordinary coverage; only explicit experimental modes select the isolated job.
def test_ancestor_pilot_is_explicit_scoped_and_readonly_for_comparisons() -> None:
    workflow = _load_workflow()
    triggers = _triggers(workflow)
    assert "ancestor-pilot" not in triggers["workflow_call"]["inputs"]
    dispatch = triggers["workflow_dispatch"]["inputs"]
    assert dispatch["ancestor-pilot"]["default"] == "off"
    assert dispatch["ancestor-pilot"]["options"] == ["off", "seed-legacy", "seed-auto", "legacy", "auto"]
    job = workflow["jobs"]["ancestor-pilot"]
    assert job["permissions"] == {"contents": "read", "actions": "read"}
    assert job["timeout-minutes"] == 15
    assert "workflow_dispatch" in job["if"] and "!= 'off'" in job["if"]
    assert "ancestor-pilot" in workflow["jobs"]["warm"]["if"]
    setup = _step_named(job, "Setup pilot cache")
    assert setup["uses"] == "zackees/setup-soldr@246b70a65b61e5c6bf415e01afc90a9a2983bdbb"
    assert setup["with"]["save-cache"] == "${{ steps.pilot.outputs.save }}"
    assert setup["with"]["cache-payload-max-bytes"] == "209715200"
    assert setup["with"]["cache-payload-oversize-action"] == "skip"
    assert setup["with"]["target-cache"] == "false"
    assert setup["with"]["prebuild-deps"] == "none"
    for name in ("fmt", "lint", "clippy", "test", "dylint"):
        assert workflow["jobs"][name]["needs"] == "warm"


def test_pilot_seed_rejects_branch_scope_and_checkout_spoof(tmp_path: Path) -> None:
    import pytest
    from scripts.ancestor_cache_pilot import WORKLOAD, configuration

    lock = tmp_path / WORKLOAD / "Cargo.lock"
    lock.parent.mkdir(parents=True)
    lock.write_text("locked fixture\n", encoding="utf-8")
    sha = "a" * 40
    env: dict[str, str] = {"PILOT_MODE": "seed-auto", "GITHUB_EVENT_NAME": "workflow_dispatch",
                           "GITHUB_REPOSITORY": "zackees/setup-soldr", "GITHUB_SHA": sha,
                           "GITHUB_REF": "refs/heads/experiment"}
    with pytest.raises(ValueError, match="main cache scope"):
        configuration(env, tmp_path, sha)
    env["GITHUB_REF"] = "refs/heads/main"
    with pytest.raises(ValueError, match="actual checkout"):
        configuration(env, tmp_path, "b" * 40)
    assert configuration(env, tmp_path, sha).source_sha == sha
    env["PILOT_MODE"] = "auto"
    with pytest.raises(ValueError, match="reviewed immutable writer"):
        configuration(env, tmp_path, sha)


def test_pilot_comparisons_disable_writes(tmp_path: Path) -> None:
    from scripts.ancestor_cache_pilot import PilotConfiguration, PilotMode, write_configuration

    for mode in PilotMode:
        output = tmp_path / mode.value
        write_configuration(PilotConfiguration(mode, "a" * 40, "fixture", "lock"), output)
        lines = output.read_text(encoding="utf-8").splitlines()
        seed = mode in (PilotMode.SEED_AUTO, PilotMode.SEED_LEGACY)
        assert f"save={'true' if seed else 'false'}" in lines
        assert f"key={'auto' if mode in (PilotMode.SEED_AUTO, PilotMode.AUTO) else ''}" in lines


def test_pilot_candidate_does_not_prove_usable_restore() -> None:
    import json
    import pytest
    from scripts.ancestor_cache_pilot import JsonValue, parse_telemetry, selected_donor_restored

    sha = "a" * 40
    document: dict[str, JsonValue] = {"selected_cache_id": 42, "selected_key": "donor",
        "write_key": "write", "identity": "identity", "distance": 1, "source_sha": sha,
        "scan_ms": 20, "api_ms": 10, "requests": 2, "rate_limit_remaining": None, "reason": "selected"}
    telemetry = parse_telemetry(json.dumps(document), sha, "write")
    assert not selected_donor_restored(telemetry, "")
    assert not selected_donor_restored(telemetry, "legacy-fallback")
    assert selected_donor_restored(telemetry, "donor")
    assert telemetry.rate_limit_remaining is None
    with pytest.raises(ValueError, match="actual checkout"):
        parse_telemetry(json.dumps(document), "b" * 40, "write")
    document["selected_cache_id"] = 0
    with pytest.raises(ValueError, match="positive"):
        parse_telemetry(json.dumps(document), sha, "write")


def test_pilot_ignores_restored_stale_compile_statistics(tmp_path: Path) -> None:
    import os
    from scripts.ancestor_cache_pilot import compilation_statistics

    stats = tmp_path / "logs" / "archive" / "first" / "last-session-stats.json"
    stats.parent.mkdir(parents=True)
    stats.write_text('{"hits": 123, "misses": 0}', encoding="utf-8")
    os.utime(stats, ns=(100, 100))
    assert compilation_statistics(tmp_path, 200).hits is None
    os.utime(stats, ns=(300, 300))
    assert compilation_statistics(tmp_path, 200).hits == 123
    second = stats.parent.parent / "second" / "last-session-stats.json"
    second.parent.mkdir()
    second.write_text('{"hits": 2, "misses": 3}', encoding="utf-8")
    assert compilation_statistics(tmp_path, 200).hits == 125
    assert compilation_statistics(tmp_path, 200).misses == 3
    stats.write_text('{"hits": true, "misses": -1}', encoding="utf-8")
    assert compilation_statistics(tmp_path, 200).hits is None
