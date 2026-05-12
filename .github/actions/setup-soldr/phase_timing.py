#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import time


def _phase_env_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").upper() or "PHASE"
    return f"SETUP_SOLDR_PHASE_{cleaned}_START_MS"


# Jobserver-internal env vars that must never propagate across runner
# steps. See setup-soldr#71.
_GITHUB_ENV_DENY_LIST = frozenset({"CARGO_MAKEFLAGS", "MAKEFLAGS"})


def _write_env(name: str, value: str) -> None:
    if name in _GITHUB_ENV_DENY_LIST:
        return
    output = os.environ.get("GITHUB_ENV", "").strip()
    if not output:
        return
    with open(output, "a", encoding="utf-8") as fh:
        fh.write(f"{name}={value}\n")


def _write_outputs(values: dict[str, str]) -> None:
    output = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not output:
        return
    with open(output, "a", encoding="utf-8") as fh:
        for key, value in values.items():
            fh.write(f"{key}={value}\n")


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def mark_phase(name: str) -> None:
    _write_env(_phase_env_name(name), str(_now_ms()))


def finish_phase(name: str) -> None:
    start_raw = os.environ.get(_phase_env_name(name), "").strip()
    try:
        start_ms = int(start_raw)
    except ValueError:
        start_ms = 0
    elapsed_ms = max(0, _now_ms() - start_ms) if start_ms else 0
    _write_outputs(
        {
            "milliseconds": str(elapsed_ms),
            "seconds": f"{elapsed_ms / 1000:.3f}",
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Record setup-soldr phase timing markers.")
    parser.add_argument("command", choices=("mark", "finish"))
    parser.add_argument("phase")
    args = parser.parse_args()

    if args.command == "mark":
        mark_phase(args.phase)
    else:
        finish_phase(args.phase)


if __name__ == "__main__":
    main()
