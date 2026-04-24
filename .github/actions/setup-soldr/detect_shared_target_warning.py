#!/usr/bin/env python3
"""Emit a GitHub Actions warning when the target-dir is pre-populated.

Repeated ``soldr cargo build`` invocations in one job that share the same
Cargo ``target/`` directory can hit a stale rust-plan and fail with a
missing ``.rmeta`` error (see https://github.com/zackees/setup-soldr/issues/53).
This helper inspects the restored target directory and, when it already
contains compiled artifacts under ``deps/``, prints a ``::warning::`` line so
workflow authors notice the pitfall before Cargo trips on it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from log_utils import log


_WARNING_MESSAGE = (
    "setup-soldr detected a pre-populated shared target directory; a "
    "subsequent `soldr cargo build` using the same `--target-dir` may fail "
    "with a missing .rmeta error - see README 'Known limitations'."
)


def _is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() == "true"


def target_dir_has_compiled_artifacts(target_dir: Path) -> bool:
    """Return True when ``target_dir`` already has compiled deps artifacts.

    We look for any ``deps/`` subtree containing a ``.rmeta`` file because
    that is the exact payload Cargo relies on when rebuilding against a
    restored target directory. An empty ``deps/`` directory (or a missing
    one) indicates a clean first run and must not trip the warning.
    """

    if not target_dir.exists() or not target_dir.is_dir():
        return False
    for deps_dir in target_dir.rglob("deps"):
        if not deps_dir.is_dir():
            continue
        try:
            entries = deps_dir.iterdir()
        except OSError:
            continue
        for entry in entries:
            if entry.is_file() and entry.suffix == ".rmeta":
                return True
    return False


def should_emit_shared_target_warning(
    *,
    build_cache_enabled: bool,
    build_cache_mode: str,
    target_cache_enabled: bool,
    target_dir: Path,
) -> bool:
    if not build_cache_enabled:
        return False
    if build_cache_mode.strip().lower() != "once":
        return False
    if not target_cache_enabled:
        return False
    return target_dir_has_compiled_artifacts(target_dir)


def main() -> None:
    build_cache_enabled = _is_truthy(os.environ.get("BUILD_CACHE_ENABLED"))
    target_cache_enabled = _is_truthy(
        os.environ.get("EFFECTIVE_TARGET_CACHE_ENABLED")
    )
    build_cache_mode = os.environ.get("BUILD_CACHE_MODE", "")
    target_dir_raw = os.environ.get("TARGET_DIR", "").strip()

    if not target_dir_raw:
        log("shared-target-dir check skipped: no target dir resolved")
        return

    target_dir = Path(target_dir_raw)
    if should_emit_shared_target_warning(
        build_cache_enabled=build_cache_enabled,
        build_cache_mode=build_cache_mode,
        target_cache_enabled=target_cache_enabled,
        target_dir=target_dir,
    ):
        print(f"::warning::{_WARNING_MESSAGE}", flush=True)
        log(
            "shared-target-dir warning emitted for "
            f"target_dir={target_dir} build_cache_mode={build_cache_mode}"
        )
    else:
        log(
            "shared-target-dir check clean for "
            f"target_dir={target_dir} build_cache_mode={build_cache_mode} "
            f"build_cache_enabled={build_cache_enabled} "
            f"target_cache_enabled={target_cache_enabled}"
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - defensive: never fail the action
        log(f"shared-target-dir check failed: {exc}")
        sys.exit(0)
