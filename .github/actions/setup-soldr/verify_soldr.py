#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys

from log_utils import log, run


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
