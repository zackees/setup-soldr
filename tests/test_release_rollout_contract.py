from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_rollout_contract_workflow_covers_main_pr_and_manual_runs() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "name: Setup Soldr Contract" in workflow
    assert "workflow_dispatch:" in workflow
    assert "push:" in workflow
    assert "pull_request:" in workflow
    assert "- .github/workflows/zccache-build-demo.yml" in workflow
    assert "- .github/workflows/setup-soldr-action.yml" in workflow
    assert "- .github/workflows/setup-soldr-contract.yml" in workflow


def test_rollout_contract_workflow_runs_unit_tests_for_the_release_path() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "python -m pytest" in workflow
    assert "tests/test_action_python_entrypoints.py" in workflow
    assert "tests/test_action_target_cache_wiring.py" in workflow
    assert "tests/test_detect_shared_target_warning.py" in workflow
    assert "tests/test_ensure_rust_toolchain_refresh.py" in workflow
    assert "tests/test_ensure_soldr_release_resolution.py" in workflow
    assert "tests/test_ensure_soldr_source_ref.py" in workflow
    assert "tests/test_phase_timing.py" in workflow
    assert "tests/test_release_rollout_contract.py" in workflow
    assert "tests/test_resolve_setup_build_cache_mode.py" in workflow
    assert "tests/test_resolve_setup_toolchain_resolution.py" in workflow
    assert "tests/test_zccache_build_demo_workflow.py" in workflow
