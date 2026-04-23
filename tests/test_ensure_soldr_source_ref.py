from __future__ import annotations

import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


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

    def test_resolve_ref_commit_sha_uses_encoded_commit_endpoint(self) -> None:
        module = _load_module()

        with patch.object(
            module.urllib.request,
            "urlopen",
            return_value=io.BytesIO(b'{"sha":"abc123"}'),
        ) as mocked:
            self.assertEqual(module._resolve_ref_commit_sha("zackees/soldr", "feature/cache-hit"), "abc123")

        request = mocked.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://api.github.com/repos/zackees/soldr/commits/feature%2Fcache-hit",
        )

    def test_source_install_match_requires_binary_metadata_and_commit_sha(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory(prefix="setup-soldr-source-") as temp_dir:
            install_dir = Path(temp_dir)
            metadata_path = module._source_metadata_path(install_dir)

            self.assertFalse(
                module._source_install_matches(
                    install_dir,
                    "zackees/soldr",
                    "fast-gh-rebuild",
                    "abc123",
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
                    "commit_sha": "abc123",
                    "target": "x86_64-unknown-linux-gnu",
                    "binary_name": "soldr",
                },
            )

            self.assertTrue(
                module._source_install_matches(
                    install_dir,
                    "zackees/soldr",
                    "fast-gh-rebuild",
                    "abc123",
                    "x86_64-unknown-linux-gnu",
                    "soldr",
                )
            )
            self.assertFalse(
                module._source_install_matches(
                    install_dir,
                    "zackees/soldr",
                    "main",
                    "abc123",
                    "x86_64-unknown-linux-gnu",
                    "soldr",
                )
            )
            self.assertFalse(
                module._source_install_matches(
                    install_dir,
                    "zackees/soldr",
                    "fast-gh-rebuild",
                    "def456",
                    "x86_64-unknown-linux-gnu",
                    "soldr",
                )
            )

    def test_main_rebuilds_when_ref_resolves_to_new_commit(self) -> None:
        module = _load_module()

        with tempfile.TemporaryDirectory(prefix="setup-soldr-source-") as temp_dir:
            install_dir = Path(temp_dir)
            binary_path = install_dir / "soldr"
            binary_path.write_text("binary", encoding="utf-8")
            module._write_source_metadata(
                module._source_metadata_path(install_dir),
                {
                    "repo": "zackees/soldr",
                    "ref": "feature/cache-hit",
                    "commit_sha": "oldsha",
                    "target": "x86_64-unknown-linux-gnu",
                    "binary_name": "soldr",
                },
            )
            output_path = install_dir / "github-output.txt"

            with (
                patch.dict(
                    os.environ,
                    {
                        "SOLDR_INSTALL_DIR": str(install_dir),
                        "SOLDR_REF": "feature/cache-hit",
                        "SOLDR_REPO": "zackees/soldr",
                        "GITHUB_OUTPUT": str(output_path),
                    },
                    clear=False,
                ),
                patch.object(
                    module,
                    "_detect_target",
                    return_value=("x86_64-unknown-linux-gnu", "tar.gz", "soldr"),
                ),
                patch.object(module, "_resolve_ref_commit_sha", return_value="newsha"),
                patch.object(module, "_build_from_source", return_value=binary_path) as mocked_build,
                patch.object(module, "_installed_version", return_value="0.7.11"),
            ):
                module.main()

            mocked_build.assert_called_once_with(
                "zackees/soldr",
                "feature/cache-hit",
                "newsha",
                install_dir,
                "x86_64-unknown-linux-gnu",
                "soldr",
            )
            self.assertEqual(output_path.read_text(encoding="utf-8"), "installed_version=0.7.11\n")


if __name__ == "__main__":
    unittest.main()
