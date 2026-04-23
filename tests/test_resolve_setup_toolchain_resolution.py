from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
RESOLVE_SETUP = REPO_ROOT / ".github" / "actions" / "setup-soldr" / "resolve_setup.py"
HELPER_DIR = RESOLVE_SETUP.parent


def _load_module():
    helper_dir = str(HELPER_DIR)
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    spec = importlib.util.spec_from_file_location("resolve_setup", RESOLVE_SETUP)
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load resolve_setup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ResolveSetupToolchainResolutionTests(unittest.TestCase):
    def test_rolling_stable_uses_manifest_release_for_cache_channel(self) -> None:
        module = _load_module()
        payload = b'[pkg.rust]\nversion = "1.95.0 (59807616e 2026-04-14)"\n'

        with patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(payload)):
            self.assertEqual(module.resolve_toolchain_cache_channel("stable"), "1.95.0")

    def test_rolling_beta_uses_manifest_release_for_cache_channel(self) -> None:
        module = _load_module()
        payload = b'[pkg.rust]\nversion = "1.96.0-beta.3 (123456789 2026-04-20)"\n'

        with patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(payload)):
            self.assertEqual(module.resolve_toolchain_cache_channel("beta"), "1.96.0-beta.3")

    def test_host_suffixed_rolling_alias_uses_same_manifest_release(self) -> None:
        module = _load_module()
        payload = b'[pkg.rust]\nversion = "1.95.0 (59807616e 2026-04-14)"\n'

        with patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(payload)):
            self.assertEqual(
                module.resolve_toolchain_cache_channel("stable-x86_64-unknown-linux-gnu"),
                "1.95.0",
            )

    def test_host_suffixed_nightly_alias_uses_same_manifest_release(self) -> None:
        module = _load_module()
        payload = b'[pkg.rust]\nversion = "1.97.0-nightly (abcdef012 2026-04-22)"\n'

        with patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(payload)):
            self.assertEqual(
                module.resolve_toolchain_cache_channel("nightly-x86_64-unknown-linux-gnu"),
                "1.97.0-nightly",
            )

    def test_pinned_toolchain_keeps_original_cache_channel(self) -> None:
        module = _load_module()

        with patch.object(module.urllib.request, "urlopen") as mocked:
            self.assertEqual(module.resolve_toolchain_cache_channel("1.95.0"), "1.95.0")

        mocked.assert_not_called()

    def test_manifest_failure_falls_back_to_requested_channel(self) -> None:
        module = _load_module()

        with patch.object(
            module.urllib.request,
            "urlopen",
            side_effect=module.urllib.error.URLError("offline"),
        ):
            self.assertEqual(module.resolve_toolchain_cache_channel("stable"), "stable")


if __name__ == "__main__":
    unittest.main()
