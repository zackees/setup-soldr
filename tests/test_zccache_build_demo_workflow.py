from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_demo_workflow_resolves_upstream_refs_with_fallbacks() -> None:
    workflow = (REPO_ROOT / ".github/workflows/zccache-build-demo.yml").read_text(
        encoding="utf-8"
    )

    assert "REQUESTED_INTEGRATION_REF: ${{ github.ref_name }}" in workflow
    assert "name: Resolve upstream integration refs" in workflow
    assert 'requested="$REQUESTED_INTEGRATION_REF"' in workflow
    assert 'git ls-remote --exit-code --heads "https://github.com/${repo}.git" "$requested"' in workflow
    assert "ref: ${{ steps.resolve-refs.outputs.zccache_ref }}" in workflow
    assert "ref: ${{ steps.resolve-refs.outputs.soldr_ref }}" in workflow
