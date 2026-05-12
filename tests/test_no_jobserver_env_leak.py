"""Regression tests for https://github.com/zackees/setup-soldr/issues/71.

The setup-soldr action must never propagate cargo/make jobserver-internal
environment variables (CARGO_MAKEFLAGS, MAKEFLAGS) into the runner's
$GITHUB_ENV. These values describe an in-process jobserver pipe that is
closed as soon as the producing process exits; leaking them across steps
causes every downstream cargo invocation to emit a "failed to connect to
jobserver" warning when it tries to attach to the now-dead file descriptors.

The contract enforced here:

* The internal `_write_env` / `append_github_env` helpers in every
  setup-soldr Python module must refuse to write the deny-listed keys.
* Invoking `resolve_setup.py` end-to-end with the leaked values set in the
  parent process environment must produce a $GITHUB_ENV file that does not
  contain those keys.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER_DIR = REPO_ROOT / ".github" / "actions" / "setup-soldr"
RESOLVE_SETUP = HELPER_DIR / "resolve_setup.py"
ENSURE_RUST_TOOLCHAIN = HELPER_DIR / "ensure_rust_toolchain.py"
PHASE_TIMING = HELPER_DIR / "phase_timing.py"

# Stale jobserver value matching the literal observed in the linked issue.
LEAKED_JOBSERVER_VALUE = "-j --jobserver-fds=8,9 --jobserver-auth=8,9"
JOBSERVER_DENY_LIST = ("CARGO_MAKEFLAGS", "MAKEFLAGS")


def _load_module(path: Path, name: str):
    helper_dir = str(HELPER_DIR)
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


@dataclass(frozen=True)
class ResolveResult:
    returncode: int
    stdout: str
    stderr: str
    env_exports: dict[str, str]
    raw_env_text: str


def _run_resolve_setup_with_jobserver_env() -> ResolveResult:
    """Invoke resolve_setup.py in a runner-like layout with the leaked
    jobserver vars set in the parent process environment.
    """
    with tempfile.TemporaryDirectory(prefix="setup-soldr-leak-") as raw_root:
        root = Path(raw_root)
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
                # The leaked jobserver values that must NOT propagate.
                "CARGO_MAKEFLAGS": LEAKED_JOBSERVER_VALUE,
                "MAKEFLAGS": LEAKED_JOBSERVER_VALUE,
            }
        )

        proc = subprocess.run(
            [sys.executable, str(RESOLVE_SETUP)],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

        raw_env_text = (
            github_env.read_text(encoding="utf-8") if github_env.exists() else ""
        )
        return ResolveResult(
            returncode=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
            env_exports=_parse_github_kv_file(github_env),
            raw_env_text=raw_env_text,
        )


class WriteEnvDenyListContractTests(unittest.TestCase):
    """The shared `_write_env` helpers must refuse to write jobserver vars.

    These are unit-level RED tests: they exercise the helper directly so
    they fail today and pass once the deny-list filter is in place.
    """

    def _assert_helper_blocks_jobserver_keys(
        self,
        module,
        write_env_attr: str,
    ) -> None:
        write_env = getattr(module, write_env_attr)
        with tempfile.TemporaryDirectory(prefix="setup-soldr-leak-unit-") as raw:
            env_path = Path(raw) / "github-env"
            os.environ["GITHUB_ENV"] = str(env_path)
            try:
                for key in JOBSERVER_DENY_LIST:
                    write_env(key, LEAKED_JOBSERVER_VALUE)
                # A known-good key should still be written so we know the
                # helper is otherwise functional.
                write_env("SETUP_SOLDR_DENYLIST_CANARY", "ok")
            finally:
                os.environ.pop("GITHUB_ENV", None)

            content = env_path.read_text(encoding="utf-8") if env_path.exists() else ""

        for key in JOBSERVER_DENY_LIST:
            self.assertNotIn(
                f"{key}=",
                content,
                msg=(
                    f"{module.__name__}.{write_env_attr} wrote forbidden key "
                    f"{key!r} to GITHUB_ENV; jobserver env vars must never "
                    "propagate across runner steps. See setup-soldr#71."
                ),
            )
        self.assertIn("SETUP_SOLDR_DENYLIST_CANARY=ok", content)

    def test_resolve_setup_write_env_blocks_jobserver_keys(self) -> None:
        module = _load_module(RESOLVE_SETUP, "resolve_setup")
        self._assert_helper_blocks_jobserver_keys(module, "_write_env")

    def test_ensure_rust_toolchain_append_github_env_blocks_jobserver_keys(
        self,
    ) -> None:
        module = _load_module(ENSURE_RUST_TOOLCHAIN, "ensure_rust_toolchain")
        self._assert_helper_blocks_jobserver_keys(module, "append_github_env")

    def test_phase_timing_write_env_blocks_jobserver_keys(self) -> None:
        module = _load_module(PHASE_TIMING, "phase_timing")
        self._assert_helper_blocks_jobserver_keys(module, "_write_env")


class ResolveSetupJobserverLeakIntegrationTests(unittest.TestCase):
    """End-to-end check: even when the leaked jobserver vars are present in
    the parent environment, resolve_setup.py must not propagate them.
    """

    def test_jobserver_vars_in_parent_env_do_not_reach_github_env(self) -> None:
        result = _run_resolve_setup_with_jobserver_env()

        self.assertEqual(
            result.returncode,
            0,
            msg=(
                "resolve_setup.py failed unexpectedly\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            ),
        )
        for key in JOBSERVER_DENY_LIST:
            self.assertNotIn(
                key,
                result.env_exports,
                msg=(
                    f"resolve_setup.py leaked {key} into $GITHUB_ENV (see "
                    "setup-soldr#71). Raw $GITHUB_ENV contents:\n"
                    f"{result.raw_env_text}"
                ),
            )
            # Defence-in-depth: the literal leaked value must not appear
            # anywhere in the file, even under a different key.
            self.assertNotIn(
                LEAKED_JOBSERVER_VALUE,
                result.raw_env_text,
                msg=(
                    "stale jobserver value appeared in $GITHUB_ENV; "
                    "see setup-soldr#71."
                ),
            )


if __name__ == "__main__":
    unittest.main()
