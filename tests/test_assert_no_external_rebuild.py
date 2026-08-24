from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ASSERTION = REPO_ROOT / "tests/cook-rematerialization/assert_no_external_rebuild.py"


def _artifact(package_id: str, *, fresh: bool) -> str:
    return json.dumps(
        {
            "reason": "compiler-artifact",
            "package_id": package_id,
            "fresh": fresh,
        }
    )


def test_reports_registry_reverse_dependents_of_path_packages_separately(
    tmp_path: Path,
) -> None:
    workspace_id = "path+file:///repo/local-patch#1.0.0"
    coupled_id = "registry+https://github.com/rust-lang/crates.io-index#coupled@1.0.0"
    fresh_id = "registry+https://github.com/rust-lang/crates.io-index#fresh@1.0.0"
    messages = tmp_path / "messages.jsonl"
    messages.write_text(
        "\n".join(
            [
                _artifact(workspace_id, fresh=False),
                _artifact(coupled_id, fresh=False),
                _artifact(fresh_id, fresh=True),
            ]
        ),
        encoding="utf-8",
    )
    metadata = tmp_path / "metadata.json"
    metadata.write_text(
        json.dumps(
            {
                "packages": [
                    {"id": workspace_id, "source": None},
                    {"id": coupled_id, "source": "registry+https://github.com/rust-lang/crates.io-index"},
                    {"id": fresh_id, "source": "registry+https://github.com/rust-lang/crates.io-index"},
                ],
                "resolve": {
                    "nodes": [
                        {"id": workspace_id, "dependencies": []},
                        {"id": coupled_id, "dependencies": [workspace_id]},
                        {"id": fresh_id, "dependencies": []},
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    report = tmp_path / "report.json"

    completed = subprocess.run(
        [sys.executable, str(ASSERTION), str(messages), str(report), "1", str(metadata)],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["external_dirty"] == []
    assert parsed["external_path_dependent_dirty"] == ["coupled"]
    assert parsed["external_fresh_count"] == 1
    assert parsed["external_total"] == 2


def test_remains_strict_without_metadata(tmp_path: Path) -> None:
    workspace_id = "path+file:///repo/workspace#1.0.0"
    dirty_id = "registry+https://github.com/rust-lang/crates.io-index#dirty@1.0.0"
    messages = tmp_path / "messages.jsonl"
    messages.write_text(
        "\n".join(
            [
                _artifact(workspace_id, fresh=False),
                _artifact(dirty_id, fresh=False),
            ]
        ),
        encoding="utf-8",
    )
    report = tmp_path / "report.json"

    completed = subprocess.run(
        [sys.executable, str(ASSERTION), str(messages), str(report), "1"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "third-party packages rebuilt" in completed.stderr
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["external_dirty"] == ["dirty"]
    assert parsed["external_path_dependent_dirty"] == []


def test_does_not_exempt_dirty_registry_package_when_path_dependency_is_fresh(
    tmp_path: Path,
) -> None:
    workspace_id = "path+file:///repo/local-patch#1.0.0"
    dirty_id = "registry+https://github.com/rust-lang/crates.io-index#dirty@1.0.0"
    messages = tmp_path / "messages.jsonl"
    messages.write_text(
        "\n".join(
            [
                _artifact(workspace_id, fresh=True),
                _artifact(dirty_id, fresh=False),
            ]
        ),
        encoding="utf-8",
    )
    metadata = tmp_path / "metadata.json"
    metadata.write_text(
        json.dumps(
            {
                "packages": [
                    {"id": workspace_id, "source": None},
                    {"id": dirty_id, "source": "registry"},
                ],
                "resolve": {
                    "nodes": [
                        {"id": workspace_id, "dependencies": []},
                        {"id": dirty_id, "dependencies": [workspace_id]},
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    report = tmp_path / "report.json"

    completed = subprocess.run(
        [sys.executable, str(ASSERTION), str(messages), str(report), "1", str(metadata)],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["external_dirty"] == ["dirty"]
    assert parsed["external_path_dependent_dirty"] == []
