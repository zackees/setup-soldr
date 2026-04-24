"""Unit coverage for the shared-target-dir warning helper."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER_DIR = REPO_ROOT / ".github" / "actions" / "setup-soldr"
HELPER_PATH = HELPER_DIR / "detect_shared_target_warning.py"


def _load_helper():
    if str(HELPER_DIR) not in sys.path:
        sys.path.insert(0, str(HELPER_DIR))
    spec = importlib.util.spec_from_file_location(
        "detect_shared_target_warning", HELPER_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_populated_target(root: Path) -> Path:
    target = root / "target"
    deps = target / "debug" / "deps"
    deps.mkdir(parents=True)
    (deps / "libring-deadbeef.rmeta").write_bytes(b"fake rmeta payload")
    return target


def _make_empty_target(root: Path) -> Path:
    target = root / "target"
    target.mkdir()
    return target


def _make_target_with_empty_deps(root: Path) -> Path:
    target = root / "target"
    (target / "debug" / "deps").mkdir(parents=True)
    return target


def test_target_dir_has_compiled_artifacts_detects_rmeta(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_populated_target(tmp_path)
    assert helper.target_dir_has_compiled_artifacts(target) is True


def test_target_dir_has_compiled_artifacts_ignores_empty_deps(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_target_with_empty_deps(tmp_path)
    assert helper.target_dir_has_compiled_artifacts(target) is False


def test_target_dir_has_compiled_artifacts_ignores_missing_target(tmp_path: Path) -> None:
    helper = _load_helper()
    assert helper.target_dir_has_compiled_artifacts(tmp_path / "target") is False


def test_target_dir_has_compiled_artifacts_ignores_non_rmeta_files(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_target_with_empty_deps(tmp_path)
    (target / "debug" / "deps" / "some.txt").write_text("not rmeta")
    assert helper.target_dir_has_compiled_artifacts(target) is False


def test_should_emit_shared_target_warning_triggers_in_once_mode(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_populated_target(tmp_path)
    assert (
        helper.should_emit_shared_target_warning(
            build_cache_enabled=True,
            build_cache_mode="once",
            target_cache_enabled=True,
            target_dir=target,
        )
        is True
    )


def test_should_emit_shared_target_warning_skips_thin_mode(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_populated_target(tmp_path)
    assert (
        helper.should_emit_shared_target_warning(
            build_cache_enabled=True,
            build_cache_mode="thin",
            target_cache_enabled=True,
            target_dir=target,
        )
        is False
    )


def test_should_emit_shared_target_warning_skips_when_build_cache_disabled(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_populated_target(tmp_path)
    assert (
        helper.should_emit_shared_target_warning(
            build_cache_enabled=False,
            build_cache_mode="once",
            target_cache_enabled=True,
            target_dir=target,
        )
        is False
    )


def test_should_emit_shared_target_warning_skips_when_target_cache_disabled(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_populated_target(tmp_path)
    assert (
        helper.should_emit_shared_target_warning(
            build_cache_enabled=True,
            build_cache_mode="once",
            target_cache_enabled=False,
            target_dir=target,
        )
        is False
    )


def test_should_emit_shared_target_warning_skips_on_clean_first_run(tmp_path: Path) -> None:
    helper = _load_helper()
    target = _make_empty_target(tmp_path)
    assert (
        helper.should_emit_shared_target_warning(
            build_cache_enabled=True,
            build_cache_mode="once",
            target_cache_enabled=True,
            target_dir=target,
        )
        is False
    )


def _run_helper_subprocess(
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(HELPER_PATH)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def helper_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    env = {
        "PATH": __import__("os").environ.get("PATH", ""),
        "PYTHONPATH": str(HELPER_DIR),
        "SETUP_SOLDR_TIMESTAMPS": "false",
    }
    return env


def test_helper_cli_prints_warning_for_risky_shape(
    tmp_path: Path, helper_env: dict[str, str]
) -> None:
    target = _make_populated_target(tmp_path)
    env = dict(helper_env)
    env.update(
        {
            "BUILD_CACHE_ENABLED": "true",
            "EFFECTIVE_TARGET_CACHE_ENABLED": "true",
            "BUILD_CACHE_MODE": "once",
            "TARGET_DIR": str(target),
        }
    )
    result = _run_helper_subprocess(env)

    assert result.returncode == 0, result.stderr
    assert "::warning::setup-soldr detected a pre-populated shared target directory" in result.stdout
    assert "Known limitations" in result.stdout


def test_helper_cli_stays_quiet_for_clean_first_run(
    tmp_path: Path, helper_env: dict[str, str]
) -> None:
    target = _make_empty_target(tmp_path)
    env = dict(helper_env)
    env.update(
        {
            "BUILD_CACHE_ENABLED": "true",
            "EFFECTIVE_TARGET_CACHE_ENABLED": "true",
            "BUILD_CACHE_MODE": "once",
            "TARGET_DIR": str(target),
        }
    )
    result = _run_helper_subprocess(env)

    assert result.returncode == 0, result.stderr
    assert "::warning::" not in result.stdout


def test_helper_cli_skips_when_target_dir_missing_env(
    helper_env: dict[str, str],
) -> None:
    env = dict(helper_env)
    env.update(
        {
            "BUILD_CACHE_ENABLED": "true",
            "EFFECTIVE_TARGET_CACHE_ENABLED": "true",
            "BUILD_CACHE_MODE": "once",
            "TARGET_DIR": "",
        }
    )
    result = _run_helper_subprocess(env)

    assert result.returncode == 0
    assert "::warning::" not in result.stdout
