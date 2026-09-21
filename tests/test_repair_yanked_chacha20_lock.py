from __future__ import annotations

from pathlib import Path
import subprocess
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
REPAIR = REPO_ROOT / "scripts" / "repair-yanked-chacha20-lock.py"

OLD = '''name = "chacha20"
version = "0.10.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "d524456ba66e72eb8b115ff89e01e497f8e6d11d78b70b1aa13c0fbd97540a81"'''
NEW = '''name = "chacha20"
version = "0.10.2"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "65c35e4b699c7e15ccbe7ee35c005e4fc0a278d22238a2857e6ce2dadeda1b06"'''


def _repair(lock_path: Path) -> None:
    subprocess.run([sys.executable, str(REPAIR), str(lock_path)], check=True)


def test_repair_replaces_the_yanked_lock_entry(tmp_path: Path) -> None:
    lock_path = tmp_path / "Cargo.lock"
    lock_path.write_text(OLD, encoding="utf-8")

    _repair(lock_path)

    assert lock_path.read_text(encoding="utf-8") == NEW


def test_repair_is_a_noop_for_unaffected_or_already_repaired_locks(tmp_path: Path) -> None:
    for name, contents in {"unaffected": 'name = "serde"\nversion = "1.0.0"\n', "repaired": NEW}.items():
        lock_path = tmp_path / f"{name}.lock"
        lock_path.write_text(contents, encoding="utf-8")

        _repair(lock_path)

        assert lock_path.read_text(encoding="utf-8") == contents
