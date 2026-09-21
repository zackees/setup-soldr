#!/usr/bin/env python3
"""Repair a yanked chacha20 lock entry in an isolated CI input."""

from __future__ import annotations

from pathlib import Path
import sys

OLD = '''name = "chacha20"
version = "0.10.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "d524456ba66e72eb8b115ff89e01e497f8e6d11d78b70b1aa13c0fbd97540a81"'''
NEW = '''name = "chacha20"
version = "0.10.2"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "65c35e4b699c7e15ccbe7ee35c005e4fc0a278d22238a2857e6ce2dadeda1b06"'''


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} <Cargo.lock>")

    lock_path = Path(sys.argv[1])
    contents = lock_path.read_text(encoding="utf-8")
    old_count = contents.count(OLD)
    if old_count == 1:
        lock_path.write_text(contents.replace(OLD, NEW), encoding="utf-8")
        return
    new_count = contents.count(NEW)
    if old_count == 0 and new_count <= 1:
        return
    raise SystemExit(f"expected at most one chacha20 0.10.1 or 0.10.2 lock entry in {lock_path}")


if __name__ == "__main__":
    main()
