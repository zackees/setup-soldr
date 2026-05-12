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


class TargetCacheCompressionResolveTests(unittest.TestCase):
    def test_default_compress_codec_is_zstd(self) -> None:
        result = _run_resolve_setup()

        self.assertEqual(
            result.returncode,
            0,
            msg=f"resolve_setup.py failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_COMPRESS"), "zstd")
        self.assertEqual(result.outputs.get("target_cache_compress"), "zstd")

    def test_default_compress_level_is_three(self) -> None:
        result = _run_resolve_setup()

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.env_exports.get("SOLDR_TARGET_CACHE_COMPRESS_LEVEL"), "3"
        )
        self.assertEqual(result.outputs.get("target_cache_compress_level"), "3")

    def test_explicit_compress_codecs_propagate_to_env(self) -> None:
        for codec in ("auto", "zstd", "none"):
            with self.subTest(codec=codec):
                result = _run_resolve_setup({"INPUT_TARGET_CACHE_COMPRESS": codec})

                self.assertEqual(result.returncode, 0)
                self.assertEqual(
                    result.env_exports.get("SOLDR_TARGET_CACHE_COMPRESS"), codec
                )
                self.assertEqual(result.outputs.get("target_cache_compress"), codec)

    def test_explicit_compress_level_propagates_to_env(self) -> None:
        for level in ("1", "3", "9", "19"):
            with self.subTest(level=level):
                result = _run_resolve_setup(
                    {"INPUT_TARGET_CACHE_COMPRESS_LEVEL": level}
                )

                self.assertEqual(result.returncode, 0)
                self.assertEqual(
                    result.env_exports.get("SOLDR_TARGET_CACHE_COMPRESS_LEVEL"),
                    level,
                )
                self.assertEqual(
                    result.outputs.get("target_cache_compress_level"), level
                )

    def test_empty_compress_codec_falls_back_to_zstd_default(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_COMPRESS": ""})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_COMPRESS"), "zstd")
        self.assertEqual(result.outputs.get("target_cache_compress"), "zstd")

    def test_empty_compress_level_falls_back_to_default_three(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_COMPRESS_LEVEL": ""})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.env_exports.get("SOLDR_TARGET_CACHE_COMPRESS_LEVEL"), "3"
        )
        self.assertEqual(result.outputs.get("target_cache_compress_level"), "3")

    def test_compress_codec_case_is_normalized_to_lowercase(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_COMPRESS": " ZSTD "})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.env_exports.get("SOLDR_TARGET_CACHE_COMPRESS"), "zstd")
        self.assertEqual(result.outputs.get("target_cache_compress"), "zstd")

    def test_invalid_compress_codec_raises_clear_error(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_COMPRESS": "lz4"})

        self.assertNotEqual(result.returncode, 0)
        combined_output = f"{result.stdout}\n{result.stderr}".lower()
        self.assertIn("invalid target-cache-compress", combined_output)
        self.assertIn("'lz4'", combined_output)
        self.assertIn("auto", combined_output)
        self.assertIn("zstd", combined_output)
        self.assertIn("none", combined_output)

    def test_invalid_compress_level_non_integer_raises_clear_error(self) -> None:
        result = _run_resolve_setup({"INPUT_TARGET_CACHE_COMPRESS_LEVEL": "fast"})

        self.assertNotEqual(result.returncode, 0)
        combined_output = f"{result.stdout}\n{result.stderr}".lower()
        self.assertIn("invalid target-cache-compress-level", combined_output)
        self.assertIn("'fast'", combined_output)

    def test_compress_level_out_of_range_raises_clear_error(self) -> None:
        for level in ("0", "23", "-1"):
            with self.subTest(level=level):
                result = _run_resolve_setup(
                    {"INPUT_TARGET_CACHE_COMPRESS_LEVEL": level}
                )

                self.assertNotEqual(result.returncode, 0)
                combined_output = f"{result.stdout}\n{result.stderr}".lower()
                self.assertIn(
                    "invalid target-cache-compress-level", combined_output
                )

    def test_compression_inputs_do_not_change_cache_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="setup-soldr-tests-shared-") as shared:
            root = Path(shared)
            baseline = _run_resolve_setup(root_override=root)
            with_inputs = _run_resolve_setup(
                {
                    "INPUT_TARGET_CACHE_COMPRESS": "none",
                    "INPUT_TARGET_CACHE_COMPRESS_LEVEL": "9",
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
