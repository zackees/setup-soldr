from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
NORMALIZE_SCRIPT = (
    REPO_ROOT / ".github" / "actions" / "setup-soldr" / "normalize_source_mtime.py"
)
HELPER_DIR = NORMALIZE_SCRIPT.parent


def _load_module():
    helper_dir = str(HELPER_DIR)
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    spec = importlib.util.spec_from_file_location(
        "normalize_source_mtime", NORMALIZE_SCRIPT
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load normalize_source_mtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(workspace: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(workspace), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _init_repo(workspace: Path) -> None:
    _git(workspace, "init", "--quiet", "--initial-branch=main")
    _git(workspace, "config", "user.email", "test@example.com")
    _git(workspace, "config", "user.name", "Test Author")
    _git(workspace, "config", "commit.gpgsign", "false")


def _commit_at(workspace: Path, timestamp: int, message: str) -> None:
    env = os.environ.copy()
    iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(timestamp)) + "+0000"
    env["GIT_AUTHOR_DATE"] = iso
    env["GIT_COMMITTER_DATE"] = iso
    env["GIT_AUTHOR_EMAIL"] = "test@example.com"
    env["GIT_AUTHOR_NAME"] = "Test Author"
    env["GIT_COMMITTER_EMAIL"] = "test@example.com"
    env["GIT_COMMITTER_NAME"] = "Test Author"
    subprocess.run(
        ["git", "-C", str(workspace), "commit", "--quiet", "-m", message],
        check=True,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class SelectCandidateFilesTests(unittest.TestCase):
    def test_matches_rust_build_inputs_and_skips_target_and_vcs(self) -> None:
        module = _load_module()
        tracked = [
            "src/main.rs",
            "crates/foo/Cargo.toml",
            "Cargo.lock",
            "build.rs",
            "rust-toolchain",
            "rust-toolchain.toml",
            "target/debug/build/generated.rs",
            "crates/foo/target/debug/generated.rs",
            "node_modules/pkg/index.rs",
            "README.md",
            "scripts/release.py",
            ".git/hooks/pre-commit",
        ]
        selected = module.select_candidate_files(tracked)
        self.assertEqual(
            sorted(selected),
            sorted(
                [
                    "src/main.rs",
                    "crates/foo/Cargo.toml",
                    "Cargo.lock",
                    "build.rs",
                    "rust-toolchain",
                    "rust-toolchain.toml",
                ]
            ),
        )


class NormalizeWorkspaceTests(unittest.TestCase):
    def _write_and_commit(
        self,
        workspace: Path,
        relative_path: str,
        content: str,
        timestamp: int,
    ) -> None:
        absolute = workspace / Path(relative_path)
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_text(content, encoding="utf-8")
        _git(workspace, "add", relative_path)
        _commit_at(workspace, timestamp, f"add {relative_path}")

    def test_touches_tracked_rust_files_to_last_commit_timestamp(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory(prefix="setup-soldr-mtime-") as tmp:
            workspace = Path(tmp)
            _init_repo(workspace)

            rs_time = 1_700_000_000
            toml_time = 1_700_100_000
            self._write_and_commit(workspace, "src/main.rs", "fn main(){}", rs_time)
            self._write_and_commit(
                workspace,
                "crates/foo/Cargo.toml",
                '[package]\nname="foo"\nversion="0.1.0"\n',
                toml_time,
            )

            # Untracked file should be left alone.
            untracked_path = workspace / "untracked.rs"
            untracked_path.write_text("fn u(){}", encoding="utf-8")
            original_untracked_mtime = untracked_path.stat().st_mtime

            # File inside target/ is tracked but must be skipped.
            target_path = workspace / "target" / "debug" / "build.rs"
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text("// generated", encoding="utf-8")
            _git(workspace, "add", "-f", "target/debug/build.rs")
            _commit_at(workspace, 1_700_200_000, "add target file")
            target_mtime_before = target_path.stat().st_mtime

            normalized, skipped = module.normalize_workspace(workspace)

            self.assertEqual(normalized, 2)
            self.assertEqual(skipped, 0)
            self.assertEqual(
                int((workspace / "src/main.rs").stat().st_mtime), rs_time
            )
            self.assertEqual(
                int((workspace / "crates/foo/Cargo.toml").stat().st_mtime),
                toml_time,
            )
            # Untracked file mtime unchanged.
            self.assertEqual(untracked_path.stat().st_mtime, original_untracked_mtime)
            # target/ file mtime unchanged.
            self.assertEqual(target_path.stat().st_mtime, target_mtime_before)


class MainEntrypointTests(unittest.TestCase):
    def test_skips_when_input_is_false(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory(prefix="setup-soldr-mtime-off-") as tmp:
            workspace = Path(tmp)
            with patch.dict(
                os.environ,
                {
                    "INPUT_SOURCE_MTIME_NORMALIZE": "false",
                    "ACTION_WORKSPACE": str(workspace),
                },
                clear=False,
            ):
                with patch.object(module, "normalize_workspace") as mocked:
                    module.main()
                    mocked.assert_not_called()

    def test_skips_when_workspace_is_not_git_repo(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory(prefix="setup-soldr-mtime-nogit-") as tmp:
            workspace = Path(tmp)
            with patch.dict(
                os.environ,
                {
                    "INPUT_SOURCE_MTIME_NORMALIZE": "true",
                    "ACTION_WORKSPACE": str(workspace),
                },
                clear=False,
            ):
                with patch.object(module, "normalize_workspace") as mocked:
                    module.main()
                    mocked.assert_not_called()

    def test_runs_when_enabled_and_in_git_repo(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory(prefix="setup-soldr-mtime-on-") as tmp:
            workspace = Path(tmp)
            _init_repo(workspace)
            (workspace / "lib.rs").write_text("pub fn x(){}", encoding="utf-8")
            _git(workspace, "add", "lib.rs")
            _commit_at(workspace, 1_700_300_000, "seed")

            with patch.dict(
                os.environ,
                {
                    "INPUT_SOURCE_MTIME_NORMALIZE": "true",
                    "ACTION_WORKSPACE": str(workspace),
                    "SETUP_SOLDR_TIMESTAMPS": "false",
                },
                clear=False,
            ):
                module.main()

            self.assertEqual(
                int((workspace / "lib.rs").stat().st_mtime), 1_700_300_000
            )


if __name__ == "__main__":
    unittest.main()
