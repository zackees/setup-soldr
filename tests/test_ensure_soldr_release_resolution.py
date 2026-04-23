from __future__ import annotations

import importlib.util
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


class EnsureSoldrReleaseResolutionTests(unittest.TestCase):
    def test_resolved_release_version_normalizes_explicit_tags(self) -> None:
        module = _load_module()

        self.assertEqual(
            module._resolved_release_version("zackees/soldr", "0.7.11"),
            ("v0.7.11", None),
        )
        self.assertEqual(
            module._resolved_release_version("zackees/soldr", "v0.7.11"),
            ("v0.7.11", None),
        )

    def test_main_reuses_cached_binary_when_latest_matches_resolved_tag(self) -> None:
        module = _load_module()

        with tempfile.TemporaryDirectory(prefix="setup-soldr-latest-") as temp_dir:
            install_dir = Path(temp_dir)
            binary_path = install_dir / "soldr"
            binary_path.write_text("binary", encoding="utf-8")
            output_path = install_dir / "github-output.txt"

            release = {
                "tag_name": "v0.7.11",
                "assets": [],
            }

            with (
                patch.dict(
                    os.environ,
                    {
                        "SOLDR_INSTALL_DIR": str(install_dir),
                        "SOLDR_REPO": "zackees/soldr",
                        "SETUP_SOLDR_VERSION": "latest",
                        "GITHUB_OUTPUT": str(output_path),
                    },
                    clear=False,
                ),
                patch.object(
                    module,
                    "_detect_target",
                    return_value=("x86_64-unknown-linux-gnu", "tar.gz", "soldr"),
                ),
                patch.object(module, "_fetch_release", return_value=release) as mocked_fetch,
                patch.object(module, "_installed_version", return_value="v0.7.11"),
                patch.object(module.urllib.request, "urlretrieve") as mocked_download,
            ):
                module.main()

            mocked_fetch.assert_called_once_with("zackees/soldr", "")
            mocked_download.assert_not_called()
            self.assertEqual(output_path.read_text(encoding="utf-8"), "installed_version=v0.7.11\n")

    def test_main_refreshes_cached_binary_when_latest_tag_changes(self) -> None:
        module = _load_module()

        with tempfile.TemporaryDirectory(prefix="setup-soldr-latest-") as temp_dir:
            install_dir = Path(temp_dir)
            binary_path = install_dir / "soldr"
            binary_path.write_text("old-binary", encoding="utf-8")
            extracted_dir = install_dir / "extract"
            extracted_dir.mkdir()
            extracted_binary = extracted_dir / "soldr"
            extracted_binary.write_text("new-binary", encoding="utf-8")
            output_path = install_dir / "github-output.txt"

            release = {
                "tag_name": "v0.7.11",
                "assets": [
                    {
                        "name": "soldr-v0.7.11-x86_64-unknown-linux-gnu.tar.gz",
                        "browser_download_url": "https://example.invalid/soldr.tar.gz",
                    }
                ],
            }

            with (
                patch.dict(
                    os.environ,
                    {
                        "SOLDR_INSTALL_DIR": str(install_dir),
                        "SOLDR_REPO": "zackees/soldr",
                        "SETUP_SOLDR_VERSION": "",
                        "GITHUB_OUTPUT": str(output_path),
                    },
                    clear=False,
                ),
                patch.object(
                    module,
                    "_detect_target",
                    return_value=("x86_64-unknown-linux-gnu", "tar.gz", "soldr"),
                ),
                patch.object(module, "_fetch_release", return_value=release) as mocked_fetch,
                patch.object(module, "_installed_version", return_value="v0.7.10"),
                patch.object(module.urllib.request, "urlretrieve") as mocked_download,
                patch.object(module, "_extract_binary", return_value=extracted_binary),
            ):
                module.main()

            mocked_fetch.assert_called_once_with("zackees/soldr", "")
            mocked_download.assert_called_once()
            self.assertEqual(binary_path.read_text(encoding="utf-8"), "new-binary")
            self.assertEqual(output_path.read_text(encoding="utf-8"), "installed_version=v0.7.11\n")


if __name__ == "__main__":
    unittest.main()
