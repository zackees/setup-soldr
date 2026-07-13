"""Contract tests for the node24 action.yml manifest.

After the port from a composite action to a node24 JavaScript action, the
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
# verbatim from the composite action; new inputs added since the node24 port
# are appended here so the contract test continues to guard the public input
# surface.
EXPECTED_INPUTS = {
    "enable",
    "version",
    "repo",
    "ref",
    "token",
    "cache",
    "cache-dir",
    "cache-key-suffix",
    "cache-preset",
    "cache-payload-warn-bytes",
    "cache-payload-max-bytes",
    "cache-payload-oversize-action",
    "cache-payload-top-n",
    "cache-encrypt-key",
    "cache-encrypt-on-failure",
    "toolchain",
    "toolchain-file",
    "trust-mode",
    "linker",
    "compile-priority",
    "timestamps",
    "timestamp-format",
    "lockfile",
    "build-cache",
    "build-cache-mode",
    "zccache-seed-strict",
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
    "compile-cache-stats",
    "shims",
    "stats",
    "debug",
    "cache-shutdown-on-idle",
    "rust-backtrace",
    "logging",
    "preserve-source-mtimes",
    "solo-toolchain-cache",
    "solo-toolchain-cache-level",
    "cache-eviction-policy",
    "prebuild-deps",
    "prebuild-deps-flags",
    "prebuild-deps-delta-cache",
    "soldr-mini-cache",
    "dylint-cache",
    "dylint-toolchain",
    "dylint-driver-rev",
    "cargo-dylint-version",
    "dylint-link-version",
    "dylint-cache-paths",
    "journal-print-raw",
    "cross-targets",
    "cross-tool",
    "verify-compile-cache",
    "seed-isolated-build-cache",
    "build-cache-save-min-compiles",
    "target-cache-save-min-compiles",
}


# Outputs preserved verbatim from the original composite action.
EXPECTED_OUTPUTS = {
    "enabled",
    "soldr-path",
    "soldr-version",
    "cache-dir",
    "setup-duration-seconds",
    "setup-phase-summary",
    "cache-hit",
    "cache-key",
    "cache-preset-effective",
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
    "dylint-cache-hit",
    "dylint-cache-key",
    "dylint-cache-restore-status",
    "dylint-driver-path",
    "toolchain",
    "stats-json",
    "shims-dir",
    "compile-cache-session-status",
    "compile-cache-hit-rate",
    "compile-cache-hits",
    "compile-cache-misses",
    "compile-cache-compilations",
    "compile-cache-time-saved-ms",
    "compile-cache-bytes-read",
    "compile-cache-bytes-written",
    "compile-cache-rollups-json",
    "compile-cache-summary-json",
    "compile-cache-sessions-total",
    "compile-cache-overall-hit-rate",
    "compile-cache-verification",
}

EXPECTED_SOLDR_DEFAULT_VERSION = "0.8.9"


def _load_action() -> dict:
    return yaml.safe_load(ACTION_PATH.read_text(encoding="utf-8"))


def test_action_runs_as_node24_with_main_and_post_entrypoints() -> None:
    manifest = _load_action()
    runs = manifest["runs"]
    assert runs["using"] == "node24"
    assert runs["main"] == "dist/main.js"
    assert runs["post"] == "dist/post.js"
    assert runs.get("post-if") == "always()"


def test_action_preserves_all_original_inputs() -> None:
    manifest = _load_action()
    assert set(manifest["inputs"]) == EXPECTED_INPUTS


def test_action_default_soldr_version_is_current_release() -> None:
    manifest = _load_action()
    version_input = manifest["inputs"]["version"]
    assert version_input["default"] == EXPECTED_SOLDR_DEFAULT_VERSION
    assert EXPECTED_SOLDR_DEFAULT_VERSION in version_input["description"]


def test_action_preserves_all_original_outputs() -> None:
    manifest = _load_action()
    assert set(manifest["outputs"]) == EXPECTED_OUTPUTS
