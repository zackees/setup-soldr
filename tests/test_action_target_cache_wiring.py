from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_target_cache_uses_separate_bundle_and_tree_paths() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "id: target-cache-lookup" in action
    assert "id: target-tree-cache-lookup" in action
    assert "path: ${{ steps.resolve.outputs.target_cache_bundle_path }}" in action
    assert "path: ${{ steps.resolve.outputs.target_cache_path }}" in action
    assert 'LogPath "target-cache bundle after restore"' in action
    assert 'LogPath "target-cache tree after restore"' in action
