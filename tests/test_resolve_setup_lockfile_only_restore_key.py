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


def _run_resolve_setup(
    extra_env: dict[str, str] | None = None,
    *,
    lockfile_contents: str = "# test lockfile\n",
    workspace_files: dict[str, str] | None = None,
) -> ResolveResult:
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
        (workspace / "Cargo.lock").write_text(lockfile_contents, encoding="utf-8")
        if workspace_files:
            for relative, contents in workspace_files.items():
                file_path = workspace / relative
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(contents, encoding="utf-8")

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


class LockfileOnlyRestoreKeyTests(unittest.TestCase):
    def test_lockfile_restore_key_emitted_in_once_mode(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "once"})

        self.assertEqual(
            result.returncode,
            0,
            msg=f"resolve_setup.py failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertEqual(result.outputs.get("target_cache_enabled"), "true")
        lockfile_prefix = result.outputs.get("target_cache_restore_key_lockfile", "")
        self.assertTrue(
            lockfile_prefix.startswith("setup-soldr-targetcache-once-v1-linux-x64-"),
            msg=f"unexpected lockfile prefix shape: {lockfile_prefix!r}",
        )
        self.assertTrue(
            lockfile_prefix.endswith("-"),
            msg=f"lockfile prefix must be a restore-key (no SHA): {lockfile_prefix!r}",
        )
        sha = "0123456789abcdef"
        self.assertNotIn(sha, lockfile_prefix)

    def test_lockfile_restore_key_emitted_in_full_mode(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "full"})

        self.assertEqual(result.returncode, 0)
        lockfile_prefix = result.outputs.get("target_cache_restore_key_lockfile", "")
        self.assertTrue(
            lockfile_prefix.startswith("setup-soldr-targetcache-full-v1-linux-x64-"),
            msg=f"unexpected lockfile prefix shape: {lockfile_prefix!r}",
        )
        self.assertTrue(lockfile_prefix.endswith("-"))

    def test_lockfile_restore_key_emitted_in_thin_mode(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "thin"})

        self.assertEqual(result.returncode, 0)
        lockfile_prefix = result.outputs.get("target_cache_restore_key_lockfile", "")
        self.assertTrue(
            lockfile_prefix.startswith("setup-soldr-targetcache-thin-v1-linux-x64-"),
            msg=f"unexpected lockfile prefix shape: {lockfile_prefix!r}",
        )

    def test_lockfile_restore_key_stable_across_manifest_changes(self) -> None:
        baseline = _run_resolve_setup(
            {"INPUT_BUILD_CACHE_MODE": "once"},
            workspace_files={
                "Cargo.toml": "[package]\nname = \"a\"\nversion = \"0.1.0\"\n",
            },
        )
        manifest_changed = _run_resolve_setup(
            {"INPUT_BUILD_CACHE_MODE": "once"},
            workspace_files={
                "Cargo.toml": (
                    "[package]\nname = \"a\"\nversion = \"0.1.0\"\n"
                    "[[bin]]\nname = \"new_bin\"\npath = \"src/main.rs\"\n"
                ),
            },
        )

        self.assertEqual(baseline.returncode, 0)
        self.assertEqual(manifest_changed.returncode, 0)
        self.assertNotEqual(
            baseline.outputs.get("target_cache_restore_key_lock"),
            manifest_changed.outputs.get("target_cache_restore_key_lock"),
            msg="manifest change should still alter the narrow restore-key",
        )
        self.assertEqual(
            baseline.outputs.get("target_cache_restore_key_lockfile"),
            manifest_changed.outputs.get("target_cache_restore_key_lockfile"),
            msg="lockfile-only restore-key must be stable across manifest changes",
        )

    def test_lockfile_restore_key_changes_when_lockfile_changes(self) -> None:
        baseline = _run_resolve_setup(
            {"INPUT_BUILD_CACHE_MODE": "once"},
            lockfile_contents="# baseline lockfile\n",
        )
        changed = _run_resolve_setup(
            {"INPUT_BUILD_CACHE_MODE": "once"},
            lockfile_contents="# different lockfile contents\n",
        )

        self.assertEqual(baseline.returncode, 0)
        self.assertEqual(changed.returncode, 0)
        self.assertNotEqual(
            baseline.outputs.get("target_cache_restore_key_lockfile"),
            changed.outputs.get("target_cache_restore_key_lockfile"),
            msg="lockfile-only restore-key must change when Cargo.lock changes",
        )

    def test_target_cache_key_unchanged_by_addition(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "once"})

        self.assertEqual(result.returncode, 0)
        target_cache_key = result.outputs.get("target_cache_key", "")
        narrow_prefix = result.outputs.get("target_cache_restore_key_lock", "")
        lockfile_prefix = result.outputs.get("target_cache_restore_key_lockfile", "")

        self.assertTrue(
            target_cache_key.startswith(narrow_prefix),
            msg=(
                "primary target_cache_key must continue to be derived from the narrow "
                f"restore-key prefix: key={target_cache_key!r} prefix={narrow_prefix!r}"
            ),
        )
        self.assertTrue(
            target_cache_key.endswith("0123456789abcdef"),
            msg=f"primary target_cache_key must end with GITHUB_SHA: {target_cache_key!r}",
        )
        self.assertNotEqual(
            narrow_prefix,
            lockfile_prefix,
            msg="lockfile-only prefix must be a distinct fallback, not the narrow prefix",
        )

    def test_lockfile_restore_key_empty_when_target_cache_disabled(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE": "false"})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.outputs.get("target_cache_enabled"), "false")
        self.assertEqual(result.outputs.get("target_cache_restore_key_lock", ""), "")
        self.assertEqual(result.outputs.get("target_cache_restore_key_lockfile", ""), "")

    def test_lockfile_restore_key_includes_suffix_fragment(self) -> None:
        result = _run_resolve_setup(
            {
                "INPUT_BUILD_CACHE_MODE": "once",
                "INPUT_CACHE_KEY_SUFFIX": "myjob",
            }
        )

        self.assertEqual(result.returncode, 0)
        lockfile_prefix = result.outputs.get("target_cache_restore_key_lockfile", "")
        self.assertTrue(
            lockfile_prefix.endswith("-myjob-"),
            msg=f"expected suffix fragment in lockfile prefix: {lockfile_prefix!r}",
        )


if __name__ == "__main__":
    unittest.main()
