from __future__ import annotations

import os
import shlex
import subprocess
import sys
import time


_FALLBACK_START = time.time()


def timestamps_enabled() -> bool:
    value = os.environ.get("SETUP_SOLDR_TIMESTAMPS", "true").strip().lower()
    return value not in {"0", "false", "no", "off"}


def color_force_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    if timestamps_enabled() and "NO_COLOR" not in env:
        env.setdefault("CARGO_TERM_COLOR", "always")
        env.setdefault("CLICOLOR_FORCE", "1")
        env.setdefault("FORCE_COLOR", "1")
    return env


def _start_epoch() -> float:
    value = os.environ.get("SETUP_SOLDR_LOG_START_EPOCH", "").strip()
    if value:
        try:
            return float(value)
        except ValueError:
            pass
    return _FALLBACK_START


def elapsed_prefix() -> str:
    elapsed = max(0, int(time.time() - _start_epoch()))
    minutes, seconds = divmod(elapsed, 60)
    return f"{minutes:02d}:{seconds:02d}"


def format_line(message: str) -> str:
    if timestamps_enabled():
        return f"{elapsed_prefix()} {message}"
    return message


def log(message: str) -> None:
    print(format_line(message), flush=True)


def run(command: list[str]) -> None:
    log(f"+ {shlex.join(command)}")
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=color_force_environment(),
    )
    assert process.stdout is not None
    for line in process.stdout:
        print(format_line(line.rstrip("\n")), flush=True)
    returncode = process.wait()
    if returncode != 0:
        raise subprocess.CalledProcessError(returncode, command)


def main() -> int:
    for line in sys.stdin.buffer:
        message = line.rstrip(b"\r\n").decode("utf-8", errors="replace")
        print(format_line(message), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
