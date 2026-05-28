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


def test_rollout_contract_workflow_builds_and_tests_the_js_action() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "actions/setup-node@" in workflow
    # Node 24 matches the GitHub Actions runtime declared by action.yml and
    # still supports --experimental-strip-types for the TypeScript test files.
    assert "node-version: 24" in workflow
    assert "npm ci" in workflow
    assert "npm run typecheck" in workflow
    assert "npm test" in workflow
    assert "npm run build" in workflow
    assert "git diff --exit-code -- dist/" in workflow


def test_rollout_contract_workflow_runs_remaining_python_contract_tests() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "python -m pytest" in workflow
    assert "tests/test_action_target_cache_wiring.py" in workflow
    assert "tests/test_release_rollout_contract.py" in workflow
    assert "tests/test_zccache_build_demo_workflow.py" in workflow
