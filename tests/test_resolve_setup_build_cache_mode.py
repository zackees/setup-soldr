from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch


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
    include_explicit_toolchain_homes: bool = True,
    clear_path: bool = False,
    create_lockfile: bool = True,
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
        if create_lockfile:
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
            }
        )
        if include_explicit_toolchain_homes:
            env.update(
                {
                    "CARGO_HOME": str(root / "cargo-home"),
                    "RUSTUP_HOME": str(root / "rustup-home"),
                }
            )
        if clear_path:
            empty_path = root / "empty-path"
            empty_path.mkdir()
            env["PATH"] = str(empty_path)
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


def _load_resolve_module():
    helper_dir = REPO_ROOT / ".github" / "actions" / "setup-soldr"
    helper_dir_str = str(helper_dir)
    if helper_dir_str not in sys.path:
        sys.path.insert(0, helper_dir_str)
    spec = importlib.util.spec_from_file_location("resolve_setup", RESOLVE_SETUP)
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load resolve_setup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_resolve_main_with_system_rustup() -> tuple[dict[str, str], dict[str, str]]:
    module = _load_resolve_module()

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
            }
        )

        with patch.dict(os.environ, env, clear=True):
            with patch.object(module, "_system_rustup_satisfies_request", return_value=True):
                module.main()

        return _parse_github_kv_file(github_env), _parse_github_kv_file(github_output)


def _run_resolve_main_direct(
    extra_env: dict[str, str] | None = None,
    *,
    resolved_soldr_version: str | None = None,
) -> tuple[dict[str, str], dict[str, str]]:
    module = _load_resolve_module()

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

        with patch.dict(os.environ, env, clear=True):
            patchers = []
            if resolved_soldr_version is not None:
                patchers.append(
                    patch.object(
                        module,
                        "_resolve_soldr_release_version",
                        return_value=resolved_soldr_version,
                    )
                )
            for patcher in patchers:
                patcher.start()
            try:
                module.main()
            finally:
                for patcher in reversed(patchers):
                    patcher.stop()

        return _parse_github_kv_file(github_env), _parse_github_kv_file(github_output)


class BuildCacheModeResolveTests(unittest.TestCase):
    def assert_target_cache_budget(
        self,
        result: ResolveResult,
        expected_bytes: str,
        expected_files: str,
    ) -> None:
        self.assertEqual(result.outputs.get("target_cache_budget_bytes"), expected_bytes)
        self.assertEqual(result.outputs.get("target_cache_budget_files"), expected_files)

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

    def test_effective_target_cache_mode_sets_soft_budget_outputs(self) -> None:
        cases = (
            ({"INPUT_BUILD_CACHE_MODE": "once"}, "1073741824", "8000"),
            ({"INPUT_BUILD_CACHE_MODE": "thin"}, "536870912", "4000"),
            ({"INPUT_BUILD_CACHE_MODE": "full"}, "2147483648", "12000"),
            ({"INPUT_TARGET_CACHE": "false"}, "", ""),
        )

        for env, expected_bytes, expected_files in cases:
            with self.subTest(env=env):
                result = _run_resolve_setup(env)
                self.assertEqual(result.returncode, 0)
                self.assert_target_cache_budget(result, expected_bytes, expected_files)

    def test_disabled_target_cache_clears_cache_path_outputs(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE": "false"})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.outputs.get("target_cache_enabled"), "false")
        self.assertEqual(result.outputs.get("target_cache_mode"), "off")
        self.assertEqual(result.outputs.get("target_cache_paths"), "")
        self.assertEqual(result.outputs.get("target_cache_budget_bytes"), "")
        self.assertEqual(result.outputs.get("target_cache_budget_files"), "")

    def test_thin_mode_without_lockfile_disables_target_cache_budget_outputs(self) -> None:
        result = _run_resolve_setup(
            {"INPUT_BUILD_CACHE_MODE": "thin"},
            create_lockfile=False,
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.outputs.get("target_lockfile_hash"), "no-lock")
        self.assertEqual(result.outputs.get("target_cache_enabled"), "false")
        self.assertEqual(result.outputs.get("target_cache_mode"), "off")
        self.assertEqual(result.outputs.get("target_cache_paths"), "")
        self.assertEqual(result.outputs.get("target_cache_budget_bytes"), "")
        self.assertEqual(result.outputs.get("target_cache_budget_files"), "")

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
        self.assertNotIn(str(setup_cache_path), result.outputs["setup_cache_paths"].splitlines())
        self.assertEqual(result.env_exports.get("ZCCACHE_CACHE_DIR"), str(build_cache_path))
        self.assertEqual(
            result.outputs["setup_cache_paths"],
            "\n".join((str(setup_cache_path / "bin"), str(soldr_root / "bin"))),
        )

    def test_default_rustup_home_lives_under_setup_cache_root(self) -> None:
        result = _run_resolve_setup(
            include_explicit_toolchain_homes=False,
            clear_path=True,
        )

        self.assertEqual(result.returncode, 0)
        setup_cache_path = Path(result.outputs["setup_cache_path"])
        rustup_home = Path(result.outputs["rustup_home"])
        cargo_home = Path(result.outputs["cargo_home"])
        self.assertEqual(rustup_home, setup_cache_path / "rustup-home")
        self.assertEqual(result.env_exports.get("RUSTUP_HOME"), str(rustup_home))
        self.assertEqual(cargo_home, Path(result.env_exports["CARGO_HOME"]))
        self.assertNotIn(setup_cache_path, cargo_home.parents)
        self.assertEqual(
            result.outputs["setup_cache_paths"],
            "\n".join(
                (
                    str(setup_cache_path / "bin"),
                    str(Path(result.outputs["soldr_bin_cache_path"])),
                    str(rustup_home / "settings.toml"),
                    str(rustup_home / "toolchains"),
                    str(rustup_home / "update-hashes"),
                )
            ),
        )

    def test_runner_rustup_home_keeps_setup_cache_bin_only_when_it_already_matches(self) -> None:
        env_exports, outputs = _run_resolve_main_with_system_rustup()
        setup_cache_path = Path(outputs["setup_cache_path"])
        rustup_home = Path(outputs["rustup_home"])

        self.assertEqual(rustup_home, Path(outputs["cargo_home"]).parent / ".rustup")
        self.assertEqual(outputs["setup_cache_layout"], "bin+soldr-bin")
        self.assertEqual(
            outputs["setup_cache_paths"],
            "\n".join((str(setup_cache_path / "bin"), outputs["soldr_bin_cache_path"])),
        )
        self.assertEqual(env_exports.get("RUSTUP_HOME"), str(rustup_home))

    def test_system_rustup_match_requires_release_components_and_targets(self) -> None:
        module = _load_resolve_module()
        toolchain = {
            "channel": "stable",
            "cache_channel": "1.95.0",
            "components": ["clippy"],
            "targets": ["wasm32-unknown-unknown"],
        }

        with (
            patch.object(module.shutil, "which", return_value="/fake/rustup"),
            patch.object(
                module,
                "_rustup_installed_names",
                side_effect=[
                    {"stable-x86_64-unknown-linux-gnu"},
                    {"clippy-x86_64-unknown-linux-gnu"},
                    {"wasm32-unknown-unknown"},
                ],
            ),
            patch.object(module, "_installed_toolchain_release", return_value="1.95.0"),
        ):
            self.assertTrue(
                module._system_rustup_satisfies_request(
                    Path("/fake/cargo-home"),
                    Path("/fake/rustup-home"),
                    toolchain,
                )
            )

    def test_system_rustup_mismatch_falls_back_to_managed_rustup_home(self) -> None:
        module = _load_resolve_module()
        toolchain = {
            "channel": "stable",
            "cache_channel": "1.95.0",
            "components": ["clippy"],
            "targets": ["wasm32-unknown-unknown"],
        }

        with (
            patch.object(module.shutil, "which", return_value="/fake/rustup"),
            patch.object(module, "_rustup_installed_names", return_value={"stable"}),
            patch.object(module, "_installed_toolchain_release", return_value="1.94.1"),
        ):
            self.assertFalse(
                module._system_rustup_satisfies_request(
                    Path("/fake/cargo-home"),
                    Path("/fake/rustup-home"),
                    toolchain,
                )
            )

    def test_setup_cache_key_changes_when_layout_switches_between_bin_only_and_managed(self) -> None:
        managed = _run_resolve_setup(
            include_explicit_toolchain_homes=False,
            clear_path=True,
        )
        _, system_outputs = _run_resolve_main_with_system_rustup()

        self.assertEqual(managed.returncode, 0)
        self.assertEqual(managed.outputs["setup_cache_layout"], "bin+soldr-bin+rustup")
        self.assertEqual(system_outputs["setup_cache_layout"], "bin+soldr-bin")
        self.assertNotEqual(managed.outputs["cache_key"], system_outputs["cache_key"])

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

    def test_explicit_version_is_normalized_for_setup_cache_keying(self) -> None:
        plain = _run_resolve_setup({"INPUT_VERSION": "0.7.11"})
        tagged = _run_resolve_setup({"INPUT_VERSION": "v0.7.11"})

        self.assertEqual(plain.returncode, 0)
        self.assertEqual(tagged.returncode, 0)
        self.assertEqual(plain.outputs.get("soldr_version_resolved"), "v0.7.11")
        self.assertEqual(tagged.outputs.get("soldr_version_resolved"), "v0.7.11")
        self.assertEqual(plain.outputs.get("cache_key"), tagged.outputs.get("cache_key"))

    def test_latest_version_is_resolved_to_concrete_release_tag(self) -> None:
        module = _load_resolve_module()

        with patch.object(module, "_fetch_release", return_value={"tag_name": "v0.7.11"}):
            self.assertEqual(
                module._resolve_soldr_release_version("zackees/soldr", "latest", ""),
                "v0.7.11",
            )
            self.assertEqual(
                module._resolve_soldr_release_version("zackees/soldr", "", ""),
                "v0.7.11",
            )

    def test_source_ref_skips_release_resolution(self) -> None:
        module = _load_resolve_module()

        with patch.object(module, "_fetch_release") as mocked_fetch:
            self.assertEqual(
                module._resolve_soldr_release_version("zackees/soldr", "latest", "feature/cache-hit"),
                "",
            )

        mocked_fetch.assert_not_called()

    def test_latest_resolution_uses_concrete_release_tag_for_cache_keying(self) -> None:
        _, first_outputs = _run_resolve_main_direct(
            {"INPUT_VERSION": "latest"},
            resolved_soldr_version="v0.7.11",
        )
        _, second_outputs = _run_resolve_main_direct(
            {"INPUT_VERSION": ""},
            resolved_soldr_version="v0.7.12",
        )

        self.assertEqual(first_outputs["soldr_version_resolved"], "v0.7.11")
        self.assertEqual(second_outputs["soldr_version_resolved"], "v0.7.12")
        self.assertNotEqual(first_outputs["cache_key"], second_outputs["cache_key"])

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
