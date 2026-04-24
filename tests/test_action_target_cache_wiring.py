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


def test_target_cache_budget_outputs_and_warning_are_wired() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "target-cache-budget-bytes:" in action
    assert "target-cache-budget-files:" in action
    assert "target-cache-footprint-bytes:" in action
    assert "target-cache-footprint-files:" in action
    assert "target-cache-budget-status:" in action
    assert "TARGET_CACHE_BUDGET_BYTES" in action
    assert "TARGET_CACHE_BUDGET_FILES" in action
    assert "MeasurePaths" in action
    assert "over-soft-budget:" in action
    assert "::warning::target-cache footprint" in action


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


def test_toolchain_step_receives_setup_cache_exact_hit_metadata() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "SETUP_SOLDR_SETUP_CACHE_EXACT_HIT" in action
    assert "steps.cache-lookup.outputs.cache-hit" in action
    assert "SETUP_SOLDR_TOOLCHAIN_CACHE_CHANNEL" in action
    assert "steps.resolve.outputs.toolchain_cache_channel" in action


def test_install_step_uses_resolved_soldr_release_version() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "GITHUB_TOKEN: ${{ github.token }}" in action
    assert "SETUP_SOLDR_VERSION: ${{ steps.resolve.outputs.soldr_version_resolved }}" in action


def test_shared_target_dir_warning_step_is_wired() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "id: shared-target-warning" in action
    assert "detect_shared_target_warning.py" in action
    assert "BUILD_CACHE_ENABLED: ${{ inputs.build-cache }}" in action
    assert (
        "EFFECTIVE_TARGET_CACHE_ENABLED: ${{ steps.resolve.outputs.target_cache_enabled }}"
        in action
    )
    assert (
        "BUILD_CACHE_MODE: ${{ steps.resolve.outputs.build_cache_mode }}" in action
    )
    assert "TARGET_DIR: ${{ steps.resolve.outputs.target_cache_path }}" in action


def test_once_mode_skips_build_cache_restore_when_target_cache_is_exact_hit() -> None:
    action = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "id: target-cache-lookup" in action
    assert "id: build-cache-lookup" in action
    assert "steps.target-cache-lookup.outputs.cache-hit != 'true'" in action
    assert "SKIP_BUILD_CACHE_FOR_TARGET_EXACT_HIT" in action
    assert "skipped-target-cache-exact-hit" in action
    assert "build-cache restore skipped because once-mode target cache was an exact hit" in action
