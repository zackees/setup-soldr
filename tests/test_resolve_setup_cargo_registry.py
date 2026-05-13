from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RESOLVE_SETUP = REPO_ROOT / ".github" / "actions" / "setup-soldr" / "resolve_setup.py"


@dataclass(frozen=True)
class ResolveResult:
    returncode: int
    stdout: str
    stderr: str
    env_exports: dict[str, str]
    outputs: dict[str, str]


def _parse_github_kv_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    lines = path.read_text(encoding="utf-8").splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if "<<" in line:
            key, delimiter = line.split("<<", 1)
            index += 1
            body: list[str] = []
            while index < len(lines) and lines[index] != delimiter:
                body.append(lines[index])
                index += 1
            values[key] = "\n".join(body)
        elif "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
        index += 1
    return values


def _run_resolve_setup(extra_env: dict[str, str] | None = None) -> ResolveResult:
    with tempfile.TemporaryDirectory(prefix="setup-soldr-tests-") as temp_dir:
        root = Path(temp_dir)
        workspace = root / "workspace"
        runner_temp = root / "runner-temp"
        home_dir = root / "home"
        github_env = root / "github-env"
        github_output = root / "github-output"
        github_path = root / "github-path"
        workspace.mkdir()
        runner_temp.mkdir()
        home_dir.mkdir()
        (workspace / "Cargo.lock").write_text("# test lockfile\n", encoding="utf-8")

        env = os.environ.copy()
        for key in list(env):
            if key.startswith(("INPUT_", "ACTION_", "GITHUB_", "SETUP_SOLDR_")):
                env.pop(key, None)
        for key in (
            "CARGO_HOME",
            "RUSTUP_HOME",
            "NO_COLOR",
            "CARGO_TERM_COLOR",
            "CLICOLOR_FORCE",
            "FORCE_COLOR",
        ):
            env.pop(key, None)

        env.update(
            {
                "ACTION_WORKSPACE": str(workspace),
                "ACTION_OS": "Linux",
                "ACTION_ARCH": "X64",
                "RUNNER_TEMP": str(runner_temp),
                "GITHUB_ENV": str(github_env),
                "GITHUB_OUTPUT": str(github_output),
                "GITHUB_PATH": str(github_path),
                "GITHUB_SHA": "0123456789abcdef",
                "HOME": str(home_dir),
                "USERPROFILE": str(home_dir),
                "INPUT_VERSION": "0.7.11",
                "INPUT_TIMESTAMPS": "false",
                "INPUT_TOOLCHAIN_FILE": "",
                "CARGO_HOME": str(root / "cargo-home"),
                "RUSTUP_HOME": str(root / "rustup-home"),
            }
        )
        if extra_env:
            env.update(extra_env)

        proc = subprocess.run(
            [sys.executable, str(RESOLVE_SETUP)],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

        return ResolveResult(
            returncode=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
            env_exports=_parse_github_kv_file(github_env),
            outputs=_parse_github_kv_file(github_output),
        )


class CargoRegistryCacheResolveTests(unittest.TestCase):
    def test_default_cargo_registry_cache_is_disabled(self) -> None:
        """Default-off: zccache CLI doesn't yet honor SOLDR_SKIP_CARGO_REGISTRY_SAVE."""
        result = _run_resolve_setup()

        self.assertEqual(
            result.returncode,
            0,
            msg=f"resolve_setup.py failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertEqual(
            result.outputs.get("cargo_registry_cache_enabled"),
            "false",
        )
        # When disabled, do NOT export the skip env (would no-op upstream).
        self.assertNotIn("SOLDR_SKIP_CARGO_REGISTRY_SAVE", result.env_exports)

    def test_opt_in_cargo_registry_emits_path_and_key(self) -> None:
        result = _run_resolve_setup({"INPUT_CARGO_REGISTRY_CACHE": "true"})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.outputs.get("cargo_registry_cache_enabled"),
            "true",
        )
        path = result.outputs.get("cargo_registry_cache_path", "")
        self.assertTrue(path.endswith("registry") or path.endswith("registry/"))
        self.assertIn("cargo-home", path.replace("\\", "/"))

        key = result.outputs.get("cargo_registry_cache_key", "")
        self.assertTrue(
            key.startswith("setup-soldr-cargoregistry-v1-linux-x64-"),
            msg=f"unexpected cargo-registry key: {key!r}",
        )

    def test_opt_in_cargo_registry_exports_skip_env(self) -> None:
        result = _run_resolve_setup({"INPUT_CARGO_REGISTRY_CACHE": "true"})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.env_exports.get("SOLDR_SKIP_CARGO_REGISTRY_SAVE"),
            "1",
        )

    def test_cargo_registry_key_includes_cargo_lock_hash(self) -> None:
        result = _run_resolve_setup({"INPUT_CARGO_REGISTRY_CACHE": "true"})

        self.assertEqual(result.returncode, 0)
        cargo_lock_hash = result.outputs.get("target_lockfile_hash", "")
        self.assertTrue(cargo_lock_hash)
        self.assertNotEqual(cargo_lock_hash, "no-lock")
        key = result.outputs.get("cargo_registry_cache_key", "")
        self.assertIn(cargo_lock_hash, key)

    def test_cargo_registry_emits_restore_key_prefixes(self) -> None:
        result = _run_resolve_setup({"INPUT_CARGO_REGISTRY_CACHE": "true"})

        self.assertEqual(result.returncode, 0)
        prefix = result.outputs.get("cargo_registry_cache_restore_prefix", "")
        self.assertTrue(
            prefix.startswith("setup-soldr-cargoregistry-v1-linux-x64-"),
            msg=f"unexpected cargo-registry restore prefix: {prefix!r}",
        )
        # The restore prefix should be a strict prefix of the full key.
        key = result.outputs.get("cargo_registry_cache_key", "")
        self.assertTrue(key.startswith(prefix))

    def test_explicit_false_does_not_export_skip_env(self) -> None:
        result = _run_resolve_setup({"INPUT_CARGO_REGISTRY_CACHE": "false"})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.outputs.get("cargo_registry_cache_enabled"),
            "false",
        )
        self.assertNotIn("SOLDR_SKIP_CARGO_REGISTRY_SAVE", result.env_exports)


if __name__ == "__main__":
    unittest.main()
