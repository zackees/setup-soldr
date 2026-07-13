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
    assert "- .github/workflows/setup-soldr-action.yml" in workflow
    assert "- .github/workflows/rust-ci.yml" in workflow
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
    # #306: verify now checks entry-point bundles only (not the whole
    # dist/), because side chunks have non-deterministic webpack-internal
    # module ordering across hosts. Sanity check ensures referenced
    # chunk files exist on disk.
    assert "git diff --exit-code -- " in workflow
    assert "dist/main.js" in workflow
    assert "dist/post.js" in workflow


def test_rollout_contract_workflow_runs_remaining_python_contract_tests() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "python -m pytest" in workflow
    assert "tests/test_action_target_cache_wiring.py" in workflow
    assert "tests/test_rust_ci_workflow.py" in workflow
    assert "tests/test_release_rollout_contract.py" in workflow


def test_default_release_readiness_is_part_of_the_contract() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "Default Release Readiness" in workflow
    assert "node scripts/check-default-release-readiness.mjs" in workflow


def test_v0_promotion_requires_a_successful_contract_and_repeats_the_gates() -> None:
    workflow = (REPO_ROOT / ".github/workflows/update-v0-tag.yml").read_text(
        encoding="utf-8"
    )

    assert "workflow_run:" in workflow
    assert 'workflows: ["Setup Soldr Contract"]' in workflow
    assert "github.event.workflow_run.conclusion == 'success'" in workflow
    assert "github.event.workflow_run.head_branch == 'main'" in workflow
    assert "github.event.workflow_run.head_sha" in workflow
    assert "node scripts/check-default-release-readiness.mjs" in workflow
    assert "uses: ./" in workflow
    assert 'git tag -f v0 "${TARGET_SHA}"' in workflow
