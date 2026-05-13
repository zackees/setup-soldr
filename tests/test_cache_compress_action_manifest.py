from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ACTION_YML = REPO_ROOT / "action.yml"
COMPRESS_ACTION_DIR = (
    REPO_ROOT / ".github" / "actions" / "setup-soldr-cache-compress"
)
COMPRESS_ACTION_YML = COMPRESS_ACTION_DIR / "action.yml"


def _read_action() -> str:
    return ACTION_YML.read_text(encoding="utf-8")


def test_setup_soldr_cache_compress_action_exists() -> None:
    assert COMPRESS_ACTION_DIR.is_dir(), (
        f"expected {COMPRESS_ACTION_DIR} to exist"
    )
    assert COMPRESS_ACTION_YML.is_file(), (
        f"expected {COMPRESS_ACTION_YML} to exist"
    )
    text = COMPRESS_ACTION_YML.read_text(encoding="utf-8")
    assert "using: node20" in text or "using: 'node20'" in text
    assert "main:" in text
    assert "post:" in text
    assert "cache-dir:" in text
    assert "codec:" in text
    assert "level:" in text


def test_setup_soldr_cache_compress_bundles_dist_files() -> None:
    main_dist = COMPRESS_ACTION_DIR / "dist" / "main.js"
    post_dist = COMPRESS_ACTION_DIR / "dist" / "post.js"
    assert main_dist.is_file(), f"expected committed bundle at {main_dist}"
    assert post_dist.is_file(), f"expected committed bundle at {post_dist}"


def test_action_invokes_cache_compress_sub_action_for_build_cache() -> None:
    action = _read_action()
    assert "./.github/actions/setup-soldr-cache-compress" in action, (
        "action.yml must invoke the local setup-soldr-cache-compress sub-action"
    )
    # The cache-compress step that wraps the build-cache directory must
    # reference the build_cache_path output (the directory to tar+zstd).
    assert (
        "cache-dir: ${{ steps.resolve.outputs.build_cache_path }}" in action
    ), "expected the build-cache compress invocation to use build_cache_path"


def test_action_build_cache_uses_tar_zst_file_path() -> None:
    action = _read_action()
    # The build-cache step should cache a `.tar.zst` file, not a directory.
    assert "build_cache_path }}.tar.zst" in action, (
        "build-cache step path must end in .tar.zst so actions/cache uploads "
        "the pre-compressed archive"
    )


def test_action_declares_cargo_registry_cache_input_default_false() -> None:
    action = _read_action()
    assert "cargo-registry-cache:" in action
    # Default must be string "false" until zccache honors the skip env var.
    lines = action.splitlines()
    found = False
    for idx, line in enumerate(lines):
        if line.strip().startswith("cargo-registry-cache:"):
            # Find the end of this input declaration: the next sibling input
            # key at the same indentation level (two spaces), or end of inputs.
            window_lines = [line]
            for follow in lines[idx + 1 :]:
                if (
                    follow.startswith("  ")
                    and not follow.startswith("   ")
                    and follow.strip()
                    and follow.strip().endswith(":")
                ):
                    break
                window_lines.append(follow)
            window = "\n".join(window_lines)
            assert 'default: "false"' in window, (
                f"cargo-registry-cache default must be \"false\"; saw window:\n{window}"
            )
            found = True
            break
    assert found, "cargo-registry-cache input declaration not found"


def test_action_has_gated_cargo_registry_cache_step() -> None:
    action = _read_action()
    # The cargo-registry cache step must be gated on the input.
    assert "inputs.cargo-registry-cache == 'true'" in action, (
        "the cargo-registry cache step must be gated on inputs.cargo-registry-cache"
    )
    # And it must cache the .tar.zst output file.
    assert "cargo_registry_cache_path }}.tar.zst" in action


def test_compress_codec_and_level_threaded_to_sub_action() -> None:
    action = _read_action()
    # The compress sub-action receives codec / level from existing inputs.
    assert "codec: ${{ inputs.target-cache-compress }}" in action
    assert "level: ${{ inputs.target-cache-compress-level }}" in action


def test_compress_step_registered_after_cache_step_for_post_ordering() -> None:
    action = _read_action()
    # Post hooks fire in reverse registration order, so actions/cache@v5
    # must be registered BEFORE setup-soldr-cache-compress. The compress
    # post (tar+zstd) runs first; actions/cache's post (upload) runs second.
    cache_idx = action.find("id: build-cache-managed")
    compress_idx = action.find(
        "uses: ./.github/actions/setup-soldr-cache-compress"
    )
    assert cache_idx != -1, "build-cache-managed step not found"
    assert compress_idx != -1, "setup-soldr-cache-compress invocation not found"
    assert cache_idx < compress_idx, (
        "actions/cache@v5 must be registered before setup-soldr-cache-compress "
        "so the JS post runs first in post-job"
    )
