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
            outputs=_parse_github_kv_file(github_output),
        )


class BuildCacheKeyV2Tests(unittest.TestCase):
    """The build-cache key version bumps to v2 because the wire format
    changes from a directory to a single .tar.zst file. Old v1 keys must
    never be restored under v2 semantics."""

    def test_build_cache_key_uses_v2_prefix(self) -> None:
        result = _run_resolve_setup()

        self.assertEqual(
            result.returncode,
            0,
            msg=f"resolve_setup.py failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        key = result.outputs.get("build_cache_key", "")
        self.assertTrue(
            key.startswith("setup-soldr-buildcache-v2-"),
            msg=f"build-cache key must start with v2 prefix, got: {key!r}",
        )
        self.assertNotIn("buildcache-v1-", key)

    def test_build_cache_restore_prefixes_use_v2(self) -> None:
        result = _run_resolve_setup()
        self.assertEqual(result.returncode, 0)

        toolchain_prefix = result.outputs.get(
            "build_cache_restore_key_toolchain", ""
        )
        os_arch_prefix = result.outputs.get(
            "build_cache_restore_key_os_arch", ""
        )
        self.assertIn("buildcache-v2-", toolchain_prefix)
        self.assertIn("buildcache-v2-", os_arch_prefix)
        self.assertNotIn("buildcache-v1-", toolchain_prefix)
        self.assertNotIn("buildcache-v1-", os_arch_prefix)


if __name__ == "__main__":
    unittest.main()
