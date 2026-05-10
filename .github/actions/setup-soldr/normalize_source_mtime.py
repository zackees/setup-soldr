#!/usr/bin/env python3
"""Normalize mtimes of tracked Rust build-input files under the workspace.

Opt-in helper that rewrites each tracked file's mtime to the Unix timestamp of
the last git commit that touched it. The goal is to keep Cargo fingerprints
stable across fresh GitHub checkouts that share the same source SHA, so
restored target-cache state can be reused as a no-op when the sources have
not actually changed.

This script is intentionally conservative:

* It only runs when ``INPUT_SOURCE_MTIME_NORMALIZE`` is truthy.
* It only touches tracked files matching known Rust build-input globs.
* It skips files under ``target/``, ``.git/``, and ``node_modules/``.
* Files with no matching commit (new / untracked) are left alone, so genuine
  source edits still invalidate Cargo fingerprints.
"""
from __future__ import annotations

import fnmatch
import os
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

from log_utils import log


_TRUTHY = {"1", "true", "yes", "on"}

# Globs evaluated against the repo-relative POSIX path of each tracked file.
_INCLUDE_GLOBS: tuple[str, ...] = (
    "*.rs",
    "**/*.rs",
    "Cargo.toml",
    "**/Cargo.toml",
    "Cargo.lock",
    "**/Cargo.lock",
    "build.rs",
    "**/build.rs",
    "rust-toolchain",
    "rust-toolchain.toml",
)

# Directory prefixes to skip regardless of glob matches.
_EXCLUDE_PREFIXES: tuple[str, ...] = (
    "target/",
    ".git/",
    "node_modules/",
)


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in _TRUTHY


def _is_git_repo(workspace: Path) -> bool:
    try:
        result = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "--is-inside-work-tree"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        return False
    return result.returncode == 0 and result.stdout.strip() == "true"


def _list_tracked_files(workspace: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(workspace), "ls-files", "-z"],
        check=True,
        stdout=subprocess.PIPE,
        text=False,
    )
    if not result.stdout:
        return []
    raw = result.stdout.split(b"\x00")
    return [entry.decode("utf-8", errors="replace") for entry in raw if entry]


def _is_excluded(relative_posix: str) -> bool:
    for prefix in _EXCLUDE_PREFIXES:
        if relative_posix == prefix.rstrip("/") or relative_posix.startswith(prefix):
            return True
        # Also skip any nested occurrence (e.g. "crates/foo/target/...").
        if f"/{prefix}" in f"/{relative_posix}":
            return True
    return False


def _matches_include(relative_posix: str) -> bool:
    basename = PurePosixPath(relative_posix).name
    for pattern in _INCLUDE_GLOBS:
        if fnmatch.fnmatchcase(relative_posix, pattern):
            return True
        if fnmatch.fnmatchcase(basename, pattern):
            return True
    return False


def select_candidate_files(tracked: list[str]) -> list[str]:
    """Filter ``tracked`` to the repo-relative files we intend to touch."""
    candidates: list[str] = []
    for entry in tracked:
        relative_posix = entry.replace("\\", "/")
        if _is_excluded(relative_posix):
            continue
        if not _matches_include(relative_posix):
            continue
        candidates.append(relative_posix)
    return candidates


def _last_commit_timestamp(workspace: Path, relative_posix: str) -> int | None:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(workspace),
            "log",
            "-1",
            "--format=%ct",
            "--",
            relative_posix,
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def normalize_workspace(workspace: Path) -> tuple[int, int]:
    """Touch eligible tracked files to their last-commit timestamp.

    Returns a ``(normalized, skipped)`` tuple where ``skipped`` counts files
    that matched the include globs but had no git history (new / untracked
    additions that arrived via some other mechanism).
    """
    tracked = _list_tracked_files(workspace)
    candidates = select_candidate_files(tracked)

    normalized = 0
    skipped = 0
    for relative_posix in candidates:
        absolute = workspace / Path(*relative_posix.split("/"))
        if not absolute.is_file():
            # Could be a symlink or removed file between ls-files and now.
            continue
        timestamp = _last_commit_timestamp(workspace, relative_posix)
        if timestamp is None:
            skipped += 1
            continue
        try:
            os.utime(absolute, (timestamp, timestamp))
        except OSError as exc:
            log(f"source-mtime-normalize: failed to touch {relative_posix}: {exc}")
            skipped += 1
            continue
        normalized += 1
    return normalized, skipped


def main() -> None:
    enabled_raw = os.environ.get("INPUT_SOURCE_MTIME_NORMALIZE", "")
    if not _is_truthy(enabled_raw):
        log(
            "source-mtime-normalize: skipped (input=%r; set 'true' to enable)"
            % enabled_raw
        )
        return

    workspace_value = os.environ.get("ACTION_WORKSPACE", "").strip()
    if not workspace_value:
        log("source-mtime-normalize: skipped (ACTION_WORKSPACE is not set)")
        return

    workspace = Path(workspace_value)
    if not workspace.is_dir():
        log(
            f"source-mtime-normalize: skipped (workspace {workspace} is not a directory)"
        )
        return

    if not _is_git_repo(workspace):
        log(
            f"source-mtime-normalize: skipped ({workspace} is not a git work tree)"
        )
        return

    start = time.monotonic()
    try:
        normalized, skipped = normalize_workspace(workspace)
    except subprocess.CalledProcessError as exc:
        log(f"source-mtime-normalize: git invocation failed: {exc}")
        raise
    elapsed_ms = int((time.monotonic() - start) * 1000)
    log(
        "source-mtime-normalize: normalized="
        f"{normalized} skipped={skipped} workspace={workspace} elapsed_ms={elapsed_ms}"
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
