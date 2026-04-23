from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ENSURE_SOLDR = REPO_ROOT / ".github" / "actions" / "setup-soldr" / "ensure_soldr.py"
HELPER_DIR = ENSURE_SOLDR.parent


def _load_module():
    helper_dir = str(HELPER_DIR)
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    spec = importlib.util.spec_from_file_location("ensure_soldr", ENSURE_SOLDR)
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load ensure_soldr.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EnsureSoldrSourceRefTests(unittest.TestCase):
    def test_source_archive_url_uses_zipball_endpoint(self) -> None:
        module = _load_module()
        self.assertEqual(
            module._source_archive_url("zackees/soldr", "fast-gh-rebuild"),
            "https://api.github.com/repos/zackees/soldr/zipball/fast-gh-rebuild",
        )

    def test_source_install_match_requires_binary_and_metadata(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory(prefix="setup-soldr-source-") as temp_dir:
            install_dir = Path(temp_dir)
            metadata_path = module._source_metadata_path(install_dir)

            self.assertFalse(
                module._source_install_matches(
                    install_dir,
                    "zackees/soldr",
                    "fast-gh-rebuild",
                    "x86_64-unknown-linux-gnu",
                    "soldr",
                )
            )

            (install_dir / "soldr").write_text("binary", encoding="utf-8")
            module._write_source_metadata(
                metadata_path,
                {
                    "repo": "zackees/soldr",
                    "ref": "fast-gh-rebuild",
                    "target": "x86_64-unknown-linux-gnu",
                    "binary_name": "soldr",
                },
            )

            self.assertTrue(
                module._source_install_matches(
                    install_dir,
                    "zackees/soldr",
                    "fast-gh-rebuild",
                    "x86_64-unknown-linux-gnu",
                    "soldr",
                )
            )
            self.assertFalse(
                module._source_install_matches(
                    install_dir,
                    "zackees/soldr",
                    "main",
                    "x86_64-unknown-linux-gnu",
                    "soldr",
                )
            )


if __name__ == "__main__":
    unittest.main()
