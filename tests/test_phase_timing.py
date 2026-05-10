from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
PHASE_TIMING = REPO_ROOT / ".github" / "actions" / "setup-soldr" / "phase_timing.py"
HELPER_DIR = PHASE_TIMING.parent


def _load_module():
    helper_dir = str(HELPER_DIR)
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    spec = importlib.util.spec_from_file_location("phase_timing", PHASE_TIMING)
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load phase_timing.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PhaseTimingTests(unittest.TestCase):
    def test_mark_phase_writes_start_timestamp_to_github_env(self) -> None:
        module = _load_module()

        with tempfile.TemporaryDirectory(prefix="setup-soldr-phase-") as temp_dir:
            env_path = Path(temp_dir) / "github-env.txt"

            with (
                patch.dict(os.environ, {"GITHUB_ENV": str(env_path)}, clear=False),
                patch.object(module, "_now_ms", return_value=12345),
            ):
                module.mark_phase("setup-cache")

            self.assertEqual(
                env_path.read_text(encoding="utf-8"),
                "SETUP_SOLDR_PHASE_SETUP_CACHE_START_MS=12345\n",
            )

    def test_finish_phase_writes_elapsed_outputs(self) -> None:
        module = _load_module()

        with tempfile.TemporaryDirectory(prefix="setup-soldr-phase-") as temp_dir:
            output_path = Path(temp_dir) / "github-output.txt"

            with (
                patch.dict(
                    os.environ,
                    {
                        "GITHUB_OUTPUT": str(output_path),
                        "SETUP_SOLDR_PHASE_TARGET_CACHE_START_MS": "1000",
                    },
                    clear=False,
                ),
                patch.object(module, "_now_ms", return_value=3456),
            ):
                module.finish_phase("target-cache")

            self.assertEqual(
                output_path.read_text(encoding="utf-8"),
                "milliseconds=2456\nseconds=2.456\n",
            )

    def test_finish_phase_defaults_to_zero_when_start_is_missing(self) -> None:
        module = _load_module()

        with tempfile.TemporaryDirectory(prefix="setup-soldr-phase-") as temp_dir:
            output_path = Path(temp_dir) / "github-output.txt"

            with (
                patch.dict(os.environ, {"GITHUB_OUTPUT": str(output_path)}, clear=False),
                patch.object(module, "_now_ms", return_value=3456),
            ):
                module.finish_phase("verify")

            self.assertEqual(
                output_path.read_text(encoding="utf-8"),
                "milliseconds=0\nseconds=0.000\n",
            )


if __name__ == "__main__":
    unittest.main()
