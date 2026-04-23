#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


def _timestamp_prefix() -> str:
    value = os.environ.get("SETUP_SOLDR_TIMESTAMPS", "true").strip().lower()
    if value in {"0", "false", "no", "off"}:
        return ""
    try:
        start = int(os.environ.get("SETUP_SOLDR_LOG_START_EPOCH", "0"))
    except ValueError:
        start = 0
    elapsed = max(0, int(time.time()) - start) if start else 0
    minutes, seconds = divmod(elapsed, 60)
    return f"{minutes:02d}:{seconds:02d} "


def _log(message: str) -> None:
    print(f"{_timestamp_prefix()}{message}", flush=True)


def _offset_path(state_dir: Path, log_path: Path) -> Path:
    safe_name = log_path.name.replace(".", "_")
    return state_dir / f"{safe_name}.offset"


def _read_offset(path: Path) -> int:
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, OSError, ValueError):
        return 0


def _write_offset(path: Path, offset: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(offset), encoding="utf-8")


def _dump_log(label: str, raw_path: str, state_dir: Path) -> None:
    if not raw_path:
        return
    path = Path(raw_path)
    if not path.exists() or not path.is_file():
        return

    offset_file = _offset_path(state_dir, path)
    previous_offset = _read_offset(offset_file)
    try:
        size = path.stat().st_size
    except OSError:
        return
    if previous_offset < 0 or previous_offset > size:
        previous_offset = 0

    try:
        with path.open("rb") as fh:
            fh.seek(previous_offset)
            chunk = fh.read()
    except OSError:
        return

    _write_offset(offset_file, size)
    if not chunk:
        return

    _log(f"{label} path={path}")
    text = chunk.decode("utf-8", errors="replace")
    for line in text.splitlines():
        print(line, flush=True)


def main() -> int:
    real_bin = os.environ.get("SETUP_SOLDR_REAL_BIN", "").strip()
    if not real_bin:
        print("setup-soldr verbose wrapper: SETUP_SOLDR_REAL_BIN is not set", file=sys.stderr)
        return 1

    command = [real_bin, *sys.argv[1:]]
    result = subprocess.run(command, check=False)

    if os.environ.get("SETUP_SOLDR_VERBOSE", "").strip().lower() in {"1", "true", "yes", "on"}:
        state_dir = Path(os.environ.get("SETUP_SOLDR_ZCCACHE_LOG_STATE_DIR", ".")).resolve()
        _dump_log(
            "setup-soldr verbose zccache daemon log",
            os.environ.get("SETUP_SOLDR_ZCCACHE_DAEMON_LOG", ""),
            state_dir,
        )
        _dump_log(
            "setup-soldr verbose zccache session journal",
            os.environ.get("SETUP_SOLDR_ZCCACHE_JOURNAL_LOG", ""),
            state_dir,
        )

    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
