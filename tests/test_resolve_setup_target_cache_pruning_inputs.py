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

PRUNING_ENV_VARS = (
    "SOLDR_TARGET_CACHE_STRIP_DEBUGINFO",
    "SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL",
    "SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES",
)

PRUNING_INPUT_TO_ENV = (
    ("INPUT_TARGET_CACHE_STRIP_DEBUGINFO", "SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"),
    ("INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL", "SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"),
    (
        "INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES",
        "SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES",
    ),
)


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
    root_override: Path | None = None,
) -> ResolveResult:
    cm = (
        tempfile.TemporaryDirectory(prefix="setup-soldr-tests-")
        if root_override is None
        else None
    )
    try:
        if root_override is not None:
            root = root_override
        else:
            assert cm is not None
            root = Path(cm.__enter__())
        workspace = root / "workspace"
        runner_temp = root / "runner-temp"
        home_dir = root / "home"
        github_env = root / "github-env"
        github_output = root / "github-output"
        github_path = root / "github-path"
        workspace.mkdir(exist_ok=True)
        runner_temp.mkdir(exist_ok=True)
        home_dir.mkdir(exist_ok=True)
        (workspace / "Cargo.lock").write_text("# test lockfile\n", encoding="utf-8")
        if github_env.exists():
            github_env.unlink()
        if github_output.exists():
            github_output.unlink()
        if github_path.exists():
            github_path.unlink()

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
    finally:
        if cm is not None:
            cm.__exit__(None, None, None)


class TargetCachePruningInputsResolveTests(unittest.TestCase):
    def test_defaults_do_not_export_pruning_env_vars(self) -> None:
        result = _run_resolve_setup()

        self.assertEqual(
            result.returncode,
            0,
            msg=f"resolve_setup.py failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        for name in PRUNING_ENV_VARS:
            self.assertNotIn(name, result.env_exports)

    def test_empty_pruning_inputs_do_not_export_env_vars(self) -> None:
        result = _run_resolve_setup(
            {
                "INPUT_TARGET_CACHE_STRIP_DEBUGINFO": "",
                "INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL": "",
                "INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES": "",
            }
        )

        self.assertEqual(result.returncode, 0)
        for name in PRUNING_ENV_VARS:
            self.assertNotIn(name, result.env_exports)

    def test_each_pruning_input_true_exports_literal_true(self) -> None:
        for input_name, env_name in PRUNING_INPUT_TO_ENV:
            with self.subTest(input_name=input_name):
                result = _run_resolve_setup({input_name: "true"})

                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.env_exports.get(env_name), "true")

    def test_each_pruning_input_false_exports_literal_false(self) -> None:
        for input_name, env_name in PRUNING_INPUT_TO_ENV:
            with self.subTest(input_name=input_name):
                result = _run_resolve_setup({input_name: "false"})

                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.env_exports.get(env_name), "false")

    def test_alternate_truthy_aliases_normalize_to_true(self) -> None:
        for raw in ("1", "yes", "on", "TRUE", " True "):
            with self.subTest(raw=raw):
                result = _run_resolve_setup(
                    {"INPUT_TARGET_CACHE_STRIP_DEBUGINFO": raw}
                )

                self.assertEqual(result.returncode, 0)
                self.assertEqual(
                    result.env_exports.get("SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"),
                    "true",
                )

    def test_alternate_falsy_aliases_normalize_to_false(self) -> None:
        for raw in ("0", "no", "off", "FALSE", " False "):
            with self.subTest(raw=raw):
                result = _run_resolve_setup(
                    {"INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL": raw}
                )

                self.assertEqual(result.returncode, 0)
                self.assertEqual(
                    result.env_exports.get("SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"),
                    "false",
                )

    def test_invalid_pruning_value_raises_clear_error(self) -> None:
        for input_name in (
            "INPUT_TARGET_CACHE_STRIP_DEBUGINFO",
            "INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL",
            "INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES",
        ):
            with self.subTest(input_name=input_name):
                result = _run_resolve_setup({input_name: "maybe"})

                self.assertNotEqual(result.returncode, 0)
                combined_output = f"{result.stdout}\n{result.stderr}".lower()
                expected_flag = input_name.removeprefix("INPUT_").lower().replace(
                    "_", "-"
                )
                self.assertIn(f"invalid {expected_flag}", combined_output)
                self.assertIn("'maybe'", combined_output)

    def test_pruning_inputs_do_not_change_cache_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="setup-soldr-tests-shared-") as shared:
            root = Path(shared)
            baseline = _run_resolve_setup(root_override=root)
            with_inputs = _run_resolve_setup(
                {
                    "INPUT_TARGET_CACHE_STRIP_DEBUGINFO": "true",
                    "INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL": "false",
                    "INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES": "false",
                },
                root_override=root,
            )

        self.assertEqual(baseline.returncode, 0)
        self.assertEqual(with_inputs.returncode, 0)
        self.assertEqual(
            baseline.outputs.get("cache_key"),
            with_inputs.outputs.get("cache_key"),
        )
        self.assertEqual(
            baseline.outputs.get("target_cache_key"),
            with_inputs.outputs.get("target_cache_key"),
        )


if __name__ == "__main__":
    unittest.main()
