#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys

from log_utils import log, run


def _version_tuple(value: str) -> tuple[int, int, int] | None:
    cleaned = value.strip().lstrip("v")
    parts = cleaned.split(".")
    if len(parts) < 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), int(parts[2].split("-", 1)[0])
    except ValueError:
        return None


def _is_transient_zccache_status_failure(exc: subprocess.CalledProcessError) -> bool:
    combined = "\n".join(
        part
        for part in (
            exc.stdout,
            exc.stderr,
            exc.output,
        )
        if isinstance(part, str) and part
    ).lower()
    return "zccache status failed" in combined and "daemon not running" in combined


def main() -> None:
    binary = os.environ["SETUP_SOLDR_PATH"]
    output_path = os.environ["GITHUB_OUTPUT"]

    log(f"Verifying soldr at {binary}")
    version_json = subprocess.check_output([binary, "version", "--json"], text=True)
    payload = json.loads(version_json)

    with open(output_path, "a", encoding="utf-8") as fh:
        fh.write(f"soldr_version={payload['soldr_version']}\n")

    if os.environ.get("SETUP_SOLDR_REQUIRE_RUST_PLAN", "").lower() == "true":
        soldr_version = str(payload["soldr_version"])
        parsed = _version_tuple(soldr_version)
        if parsed is None or parsed < (0, 7, 10):
            mode = os.environ.get("SETUP_SOLDR_BUILD_CACHE_MODE", "thin")
            raise RuntimeError(
                "setup-soldr build-cache-mode "
                f"{mode!r} requires soldr v0.7.10 or newer for the "
                f"zccache Rust artifact plan API; installed {soldr_version}."
            )

    run(["cargo", "--version"])
    run(["rustc", "--version"])
    log("+ soldr status --json")
    try:
        status = subprocess.run(
            ["soldr", "status", "--json"],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        if not _is_transient_zccache_status_failure(exc):
            raise
    else:
        if status.stdout.strip():
            for line in status.stdout.splitlines():
                log(line)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)
