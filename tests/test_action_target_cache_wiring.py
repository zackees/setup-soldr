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


def test_target_tree_cache_is_only_used_in_full_mode() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "steps.resolve.outputs.build_cache_mode == 'full'" in action
    assert "id: target-tree-cache-managed" not in action


def test_setup_cache_uses_lookup_exact_restore_and_managed_fallback() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "id: cache-lookup" in action
    assert "id: cache-restore" in action
    assert "id: cache-managed" in action
    assert "uses: actions/cache/restore@" in action
    assert "uses: actions/cache@" in action
    assert "lookup-only: true" in action
    assert "steps.cache-lookup.outputs.cache-hit == 'true'" in action
    assert "steps.cache-lookup.outputs.cache-hit != 'true'" in action
    assert "steps.resolve.outputs.setup_cache_paths" in action
    assert 'LogPath "soldr-bin after restore"' in action
    assert "id: cache-save" not in action
