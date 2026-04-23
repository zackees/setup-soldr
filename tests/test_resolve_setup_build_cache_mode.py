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
        github_env = root / "github-env"
        github_output = root / "github-output"
        github_path = root / "github-path"
        workspace.mkdir()
        runner_temp.mkdir()
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
                "CARGO_HOME": str(root / "cargo-home"),
                "RUSTUP_HOME": str(root / "rustup-home"),
                "INPUT_TIMESTAMPS": "false",
                "INPUT_TOOLCHAIN_FILE": "",
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


class BuildCacheModeResolveTests(unittest.TestCase):
    def assert_resolved_build_cache_mode(
        self,
        result: ResolveResult,
        expected: str,
        soldr_expected: str | None = None,
        target_expected: str | None = None,
        output_target_expected: str | None = None,
    ) -> None:
        self.assertEqual(
            result.returncode,
            0,
            msg=f"resolve_setup.py failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertEqual(result.outputs.get("build_cache_mode"), expected)
        self.assertEqual(result.outputs.get("target_cache_mode"), output_target_expected or expected)
        self.assertEqual(result.env_exports.get("SETUP_SOLDR_BUILD_CACHE_MODE"), expected)
        self.assertEqual(result.env_exports.get("SOLDR_BUILD_CACHE_MODE"), soldr_expected or expected)
        self.assertEqual(
            result.env_exports.get("SOLDR_TARGET_CACHE_MODE"),
            target_expected or soldr_expected or expected,
        )
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_BACKEND"), "local")

    def test_default_build_cache_mode_resolves_to_once(self) -> None:
        self.assert_resolved_build_cache_mode(_run_resolve_setup(), "once", "full")

    def test_once_thin_and_full_build_cache_modes_are_accepted(self) -> None:
        for mode, soldr_mode in (("once", "full"), ("thin", "thin"), ("full", "full")):
            with self.subTest(mode=mode):
                result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": mode})
                self.assert_resolved_build_cache_mode(result, mode, soldr_mode)

    def test_once_mode_restores_only_the_local_rust_plan_bundle(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "once"})

        self.assertEqual(result.returncode, 0)
        target_path = result.outputs.get("target_cache_path")
        bundle_path = result.outputs.get("target_cache_bundle_path")
        self.assertTrue(target_path)
        self.assertTrue(bundle_path)
        self.assertNotEqual(bundle_path, target_path)
        self.assertEqual(result.outputs.get("target_cache_paths"), bundle_path)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_DIR"), target_path)
        self.assertEqual(
            result.env_exports.get("SOLDR_TARGET_CACHE_BUNDLE_DIR"),
            bundle_path,
        )

    def test_build_cache_path_stays_under_soldr_root_outside_setup_cache_root(self) -> None:
        result = _run_resolve_setup()

        self.assertEqual(result.returncode, 0)
        setup_cache_path = Path(result.outputs["setup_cache_path"])
        soldr_root = Path(result.outputs["soldr_root"])
        build_cache_path = Path(result.outputs["build_cache_path"])
        self.assertNotEqual(soldr_root, setup_cache_path)
        self.assertNotIn(setup_cache_path, soldr_root.parents)
        self.assertEqual(build_cache_path, soldr_root / "cache" / "zccache")
        self.assertNotIn(setup_cache_path, build_cache_path.parents)
        self.assertEqual(result.outputs["soldr_bin_cache_path"], str(soldr_root / "bin"))
        self.assertEqual(result.env_exports.get("ZCCACHE_CACHE_DIR"), str(build_cache_path))
        self.assertEqual(
            result.outputs["setup_cache_paths"],
            f"{setup_cache_path}\n{soldr_root / 'bin'}",
        )

    def test_full_mode_restores_target_tree_and_bundle_root_together(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "full"})

        self.assertEqual(result.returncode, 0)
        target_path = result.outputs.get("target_cache_path")
        bundle_path = result.outputs.get("target_cache_bundle_path")
        self.assertTrue(target_path)
        self.assertTrue(bundle_path)
        self.assertNotEqual(bundle_path, target_path)
        self.assertEqual(
            result.outputs.get("target_cache_paths"),
            f"{target_path}\n{bundle_path}",
        )
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_DIR"), target_path)
        self.assertEqual(
            result.env_exports.get("SOLDR_TARGET_CACHE_BUNDLE_DIR"),
            bundle_path,
        )

    def test_thin_mode_keeps_local_rust_plan_bundle_separate_from_target_tree(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "thin"})

        self.assertEqual(result.returncode, 0)
        target_path = result.outputs.get("target_cache_path")
        bundle_path = result.outputs.get("target_cache_bundle_path")
        self.assertTrue(target_path)
        self.assertTrue(bundle_path)
        self.assertNotEqual(bundle_path, target_path)
        self.assertEqual(result.outputs.get("target_cache_paths"), bundle_path)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_DIR"), target_path)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_BUNDLE_DIR"), bundle_path)

    def test_unknown_build_cache_mode_fails_clearly(self) -> None:
        result = _run_resolve_setup({"INPUT_BUILD_CACHE_MODE": "wide"})

        self.assertNotEqual(result.returncode, 0)
        combined_output = f"{result.stdout}\n{result.stderr}".lower()
        self.assertIn("invalid build-cache-mode", combined_output)
        self.assertIn("once", combined_output)
        self.assertIn("thin", combined_output)
        self.assertIn("full", combined_output)

    def test_repo_and_ref_are_exported_for_installer(self) -> None:
        result = _run_resolve_setup(
            {
                "INPUT_REPO": "zackees/soldr",
                "INPUT_REF": "fast-gh-rebuild",
            }
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.outputs.get("soldr_repo"), "zackees/soldr")
        self.assertEqual(result.outputs.get("soldr_ref"), "fast-gh-rebuild")

    def test_source_ref_changes_setup_cache_key(self) -> None:
        base = _run_resolve_setup({"INPUT_REPO": "zackees/soldr"})
        branch = _run_resolve_setup(
            {
                "INPUT_REPO": "zackees/soldr",
                "INPUT_REF": "fast-gh-rebuild",
            }
        )

        self.assertEqual(base.returncode, 0)
        self.assertEqual(branch.returncode, 0)
        self.assertNotEqual(base.outputs.get("cache_key"), branch.outputs.get("cache_key"))

    def test_legacy_target_cache_inputs_translate_deterministically(self) -> None:
        cases = (
            ({"INPUT_TARGET_CACHE_MODE": "hot"}, "thin", "thin"),
            ({"INPUT_TARGET_CACHE_MODE": "full"}, "full", "full"),
            ({"INPUT_TARGET_CACHE_MODE": "off"}, "once", "full", "off", "off"),
            (
                {"INPUT_TARGET_CACHE": "false", "INPUT_TARGET_CACHE_MODE": "full"},
                "once",
                "full",
                "off",
                "off",
            ),
            (
                {
                    "INPUT_BUILD_CACHE_MODE": "thin",
                    "INPUT_TARGET_CACHE": "true",
                    "INPUT_TARGET_CACHE_MODE": "full",
                },
                "thin",
                "thin",
            ),
            (
                {
                    "INPUT_BUILD_CACHE_MODE": "full",
                    "INPUT_TARGET_CACHE": "false",
                    "INPUT_TARGET_CACHE_MODE": "hot",
                },
                "full",
                "full",
                "off",
                "off",
            ),
        )

        for case in cases:
            env = case[0]
            expected = case[1]
            soldr_expected = case[2]
            target_expected = case[3] if len(case) > 3 else None
            output_target_expected = case[4] if len(case) > 4 else None
            with self.subTest(env=env):
                result = _run_resolve_setup(env)
                self.assert_resolved_build_cache_mode(
                    result,
                    expected,
                    soldr_expected,
                    target_expected,
                    output_target_expected,
                )


if __name__ == "__main__":
    unittest.main()
