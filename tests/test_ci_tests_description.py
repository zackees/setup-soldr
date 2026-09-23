"""Public ci-tests input description follows the action's resolver contract."""

from pathlib import Path

import yaml


def test_ci_tests_description_preserves_compiler_concurrency() -> None:
    action_path = Path(__file__).resolve().parents[1] / "action.yml"
    action = yaml.safe_load(action_path.read_text(encoding="utf-8"))
    description = action["inputs"]["ci-tests"]["description"]

    assert "CARGO_BUILD_JOBS and SOLDR_JOBS remain unset unless the workflow sets them" in description
    assert "Only NEXTEST_TEST_THREADS defaults to one" in description
