from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
ENSURE_RUST_TOOLCHAIN = (
    REPO_ROOT / ".github" / "actions" / "setup-soldr" / "ensure_rust_toolchain.py"
)
HELPER_DIR = ENSURE_RUST_TOOLCHAIN.parent


def _load_module():
    helper_dir = str(HELPER_DIR)
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    spec = importlib.util.spec_from_file_location(
        "ensure_rust_toolchain", ENSURE_RUST_TOOLCHAIN
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load ensure_rust_toolchain.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EnsureRustToolchainRefreshTests(unittest.TestCase):
    def test_should_refresh_rolling_channels_only(self) -> None:
        module = _load_module()

        self.assertTrue(module.should_refresh_toolchain("stable"))
        self.assertTrue(module.should_refresh_toolchain("beta"))
        self.assertTrue(module.should_refresh_toolchain("nightly"))
        self.assertTrue(module.should_refresh_toolchain("stable-x86_64-unknown-linux-gnu"))
        self.assertFalse(module.should_refresh_toolchain("nightly-2026-04-01"))
        self.assertFalse(module.should_refresh_toolchain("1.95.0"))

    def test_main_refreshes_installed_stable_channel(self) -> None:
        module = _load_module()
        commands: list[list[str]] = []

        def fake_run(command: list[str]) -> None:
            commands.append(command)

        with tempfile.TemporaryDirectory(prefix="setup-soldr-toolchain-") as temp_dir:
            root = Path(temp_dir)
            env = {
                "CARGO_HOME": str(root / "cargo-home"),
                "RUSTUP_HOME": str(root / "rustup-home"),
                "SOLDR_CACHE_DIR": str(root / "soldr"),
                "SETUP_SOLDR_TOOLCHAIN_CHANNEL": "stable",
                "SETUP_SOLDR_TOOLCHAIN_PROFILE": "minimal",
            }

            with patch.dict(os.environ, env, clear=False):
                with (
                    patch.object(module, "ensure_rustup_available", return_value="rustup"),
                    patch.object(module, "toolchain_available", return_value=True),
                    patch.object(module, "_json_list_env", return_value=[]),
                    patch.object(module, "add_components"),
                    patch.object(module, "add_targets"),
                    patch.object(module, "run", side_effect=fake_run),
                    patch.object(
                        module.shutil,
                        "which",
                        side_effect=lambda name: f"/fake/{name}"
                        if name in {"cargo", "rustc", "rustup"}
                        else None,
                    ),
                ):
                    module.main()

        self.assertIn(
            ["rustup", "toolchain", "install", "stable", "--profile", "minimal"],
            commands,
        )

    def test_main_reuses_installed_pinned_toolchain_without_refresh(self) -> None:
        module = _load_module()
        commands: list[list[str]] = []

        def fake_run(command: list[str]) -> None:
            commands.append(command)

        with tempfile.TemporaryDirectory(prefix="setup-soldr-toolchain-") as temp_dir:
            root = Path(temp_dir)
            env = {
                "CARGO_HOME": str(root / "cargo-home"),
                "RUSTUP_HOME": str(root / "rustup-home"),
                "SOLDR_CACHE_DIR": str(root / "soldr"),
                "SETUP_SOLDR_TOOLCHAIN_CHANNEL": "1.95.0",
                "SETUP_SOLDR_TOOLCHAIN_PROFILE": "minimal",
            }

            with patch.dict(os.environ, env, clear=False):
                with (
                    patch.object(module, "ensure_rustup_available", return_value="rustup"),
                    patch.object(module, "toolchain_available", return_value=True),
                    patch.object(module, "_json_list_env", return_value=[]),
                    patch.object(module, "add_components"),
                    patch.object(module, "add_targets"),
                    patch.object(module, "run", side_effect=fake_run),
                    patch.object(
                        module.shutil,
                        "which",
                        side_effect=lambda name: f"/fake/{name}"
                        if name in {"cargo", "rustc", "rustup"}
                        else None,
                    ),
                ):
                    module.main()

        self.assertNotIn(
            ["rustup", "toolchain", "install", "1.95.0", "--profile", "minimal"],
            commands,
        )


if __name__ == "__main__":
    unittest.main()
