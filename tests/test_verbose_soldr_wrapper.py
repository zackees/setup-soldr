from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WRAPPER = REPO_ROOT / ".github" / "actions" / "setup-soldr" / "verbose_soldr_wrapper.py"


class VerboseSoldrWrapperTests(unittest.TestCase):
    def test_wrapper_preserves_exit_code_and_dumps_new_logs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="setup-soldr-wrapper-") as temp_dir:
            root = Path(temp_dir)
            daemon_log = root / "daemon.log"
            journal_log = root / "last-session.jsonl"
            state_dir = root / "state"
            real_soldr = root / "real_soldr.py"

            real_soldr.write_text(
                textwrap.dedent(
                    f"""\
                    import pathlib
                    import sys

                    pathlib.Path({str(daemon_log)!r}).write_text("daemon line\\n", encoding="utf-8")
                    pathlib.Path({str(journal_log)!r}).write_text('{{"event":"session"}}\\n', encoding="utf-8")
                    raise SystemExit(7)
                    """
                ),
                encoding="utf-8",
            )

            env = os.environ.copy()
            env.update(
                {
                    "SETUP_SOLDR_REAL_BIN": sys.executable,
                    "SETUP_SOLDR_VERBOSE": "true",
                    "SETUP_SOLDR_TIMESTAMPS": "false",
                    "SETUP_SOLDR_ZCCACHE_DAEMON_LOG": str(daemon_log),
                    "SETUP_SOLDR_ZCCACHE_JOURNAL_LOG": str(journal_log),
                    "SETUP_SOLDR_ZCCACHE_LOG_STATE_DIR": str(state_dir),
                }
            )

            result = subprocess.run(
                [sys.executable, str(WRAPPER), str(real_soldr)],
                cwd=REPO_ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 7)
            self.assertIn("setup-soldr verbose zccache daemon log", result.stdout)
            self.assertIn("daemon line", result.stdout)
            self.assertIn("setup-soldr verbose zccache session journal", result.stdout)
            self.assertIn('"event":"session"', result.stdout)


if __name__ == "__main__":
    unittest.main()
