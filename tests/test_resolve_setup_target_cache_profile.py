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


class TargetCacheProfileResolveTests(unittest.TestCase):
    def test_default_profile_is_thin_v1_when_input_absent(self) -> None:
        result = _run_resolve_setup()

        self.assertEqual(
            result.returncode,
            0,
            msg=f"resolve_setup.py failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_PROFILE"), "thin-v1")
        self.assertEqual(result.outputs.get("target_cache_profile"), "thin-v1")

    def test_empty_profile_input_falls_back_to_thin_v1(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_PROFILE": ""})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_PROFILE"), "thin-v1")
        self.assertEqual(result.outputs.get("target_cache_profile"), "thin-v1")

    def test_explicit_thin_v1_profile_propagates_to_env(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_PROFILE": "thin-v1"})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_PROFILE"), "thin-v1")
        self.assertEqual(result.outputs.get("target_cache_profile"), "thin-v1")

    def test_thin_v2_profile_propagates_to_env(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_PROFILE": "thin-v2"})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_PROFILE"), "thin-v2")
        self.assertEqual(result.outputs.get("target_cache_profile"), "thin-v2")

    def test_invalid_profile_raises_clear_error(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_PROFILE": "thick"})

        self.assertNotEqual(result.returncode, 0)
        combined_output = f"{result.stdout}\n{result.stderr}".lower()
        self.assertIn("invalid target-cache-profile", combined_output)
        self.assertIn("thin-v1", combined_output)
        self.assertIn("thin-v2", combined_output)

    def test_default_profile_does_not_change_setup_cache_key(self) -> None:
        baseline = _run_resolve_setup()
        explicit_v1 = _run_resolve_setup({"INPUT_TARGET_CACHE_PROFILE": "thin-v1"})
        explicit_v2 = _run_resolve_setup({"INPUT_TARGET_CACHE_PROFILE": "thin-v2"})

        self.assertEqual(baseline.returncode, 0)
        self.assertEqual(explicit_v1.returncode, 0)
        self.assertEqual(explicit_v2.returncode, 0)
        self.assertEqual(
            baseline.outputs.get("cache_key"),
            explicit_v1.outputs.get("cache_key"),
        )
        self.assertEqual(
            baseline.outputs.get("cache_key"),
            explicit_v2.outputs.get("cache_key"),
        )


if __name__ == "__main__":
    unittest.main()
