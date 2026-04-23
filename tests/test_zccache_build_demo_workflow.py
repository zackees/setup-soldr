from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _workflow_text() -> str:
    return (REPO_ROOT / ".github/workflows/zccache-build-demo.yml").read_text(
        encoding="utf-8"
    )


def test_demo_workflow_resolves_upstream_refs_with_fallbacks() -> None:
    workflow = _workflow_text()

    assert "REQUESTED_INTEGRATION_REF: ${{ github.ref_name }}" in workflow
    assert "name: Resolve upstream integration refs" in workflow
    assert 'requested="$REQUESTED_INTEGRATION_REF"' in workflow
    assert 'git ls-remote --exit-code --heads "https://github.com/${repo}.git" "$requested"' in workflow
    assert "ref: ${{ steps.resolve-refs.outputs.zccache_ref }}" in workflow
    assert "ref: ${{ steps.resolve-refs.outputs.soldr_ref }}" in workflow


def test_demo_workflow_uses_checked_out_action_and_resolved_soldr_repo() -> None:
    workflow = _workflow_text()

    assert "name: Checkout setup-soldr action" in workflow
    assert "uses: ./setup-soldr" in workflow
    assert "repo: zackees/soldr" in workflow
    assert "ref: ${{ steps.resolve-refs.outputs.soldr_ref }}" in workflow


def test_demo_workflow_preserves_cold_then_warm_rollout_path() -> None:
    workflow = _workflow_text()

    assert "default: Warm build only" in workflow
    assert "- Purge cache and run cold build before warm build" in workflow
    assert "needs: purge-demo-caches" in workflow
    assert "needs:\n      - purge-demo-caches\n      - cold-build" in workflow
    assert "name: Build zccache cold" in workflow
    assert "name: Build zccache warm" in workflow
    assert "soldr cargo build --locked --package zccache-cli" in workflow
