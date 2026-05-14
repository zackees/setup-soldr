"""Contract tests for the node20 action.yml manifest.

After the port from a composite action to a node20 JavaScript action, the
manifest no longer carries any shell steps — runtime behavior lives in
``dist/main.js`` / ``dist/post.js``. These tests guard the public surface of
the manifest: the runner declaration, dist entrypoints, and the full set of
inputs/outputs that downstream callers depend on.
"""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
ACTION_PATH = REPO_ROOT / "action.yml"


# Full set of inputs the action.yml manifest exposes. Originally preserved
# verbatim from the composite action; new inputs added since the node20 port
# are appended here so the contract test continues to guard the public input
# surface.
EXPECTED_INPUTS = {
    "version",
    "repo",
    "ref",
    "token",
    "cache",
    "cache-dir",
    "cache-key-suffix",
    "toolchain",
    "toolchain-file",
    "trust-mode",
    "linker",
    "compile-priority",
    "timestamps",
    "lockfile",
    "build-cache",
    "build-cache-mode",
    "target-cache",
    "target-cache-mode",
    "target-dir",
    "target-cache-profile",
    "target-cache-strip-debuginfo",
    "target-cache-include-incremental",
    "target-cache-include-build-script-binaries",
    "target-cache-compress",
    "target-cache-compress-level",
    "source-mtime-normalize",
    "cargo-registry-cache",
}


# Outputs preserved verbatim from the original composite action.
EXPECTED_OUTPUTS = {
    "soldr-path",
    "soldr-version",
    "cache-dir",
    "setup-duration-seconds",
    "setup-phase-summary",
    "cache-hit",
    "cache-key",
    "cache-restore-status",
    "build-cache-hit",
    "build-cache-key",
    "build-cache-path",
    "build-cache-mode",
    "build-cache-restore-status",
    "target-cache-hit",
    "target-cache-key",
    "target-cache-path",
    "target-cache-paths",
    "target-cache-mode",
    "target-cache-profile",
    "target-cache-compress",
    "target-cache-compress-level",
    "target-cache-restore-status",
    "target-cache-budget-bytes",
    "target-cache-budget-files",
    "target-cache-footprint-bytes",
    "target-cache-footprint-files",
    "target-cache-budget-status",
    "target-lockfile",
    "target-lockfile-hash",
    "toolchain",
}


def _load_action() -> dict:
    return yaml.safe_load(ACTION_PATH.read_text(encoding="utf-8"))


def test_action_runs_as_node20_with_main_and_post_entrypoints() -> None:
    manifest = _load_action()
    runs = manifest["runs"]
    assert runs["using"] == "node20"
    assert runs["main"] == "dist/main.js"
    assert runs["post"] == "dist/post.js"
    assert runs.get("post-if") == "success()"


def test_action_preserves_all_original_inputs() -> None:
    manifest = _load_action()
    assert set(manifest["inputs"]) == EXPECTED_INPUTS


def test_action_preserves_all_original_outputs() -> None:
    manifest = _load_action()
    assert set(manifest["outputs"]) == EXPECTED_OUTPUTS
