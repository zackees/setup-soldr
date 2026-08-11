"""Public contract for blessed target preparation (issue #386)."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
ACTION_PATH = REPO_ROOT / "action.yml"
README_PATH = REPO_ROOT / "README.md"
CONTRACT_PATH = REPO_ROOT / "tests" / "test_action_target_cache_wiring.py"
CROSS_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "cross-prepare.yml"
SMOKE_FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "target-smoke"


def test_cross_target_action_description_has_only_blessed_contract() -> None:
    manifest = yaml.safe_load(ACTION_PATH.read_text(encoding="utf-8"))
    description = manifest["inputs"]["cross-targets"]["description"]

    assert "one canonical Rust target triple" in description
    assert "use a matrix for multiple targets" in description
    assert "soldr prepare" in description.lower() or "`prepare`" in description
    for retired in (
        "cargo-zigbuild",
        "ziglang",
        "cross-tool",
        "warn and continue",
        "per-(host",
    ):
        assert retired not in description


def test_readme_recommends_only_target_driven_cross_compilation() -> None:
    readme = README_PATH.read_text(encoding="utf-8")

    assert "The default Soldr version is `0.9.0`." in readme
    assert "### Legacy cross-compile auto-bootstrap" not in readme
    assert "soldr cargo zigbuild" not in readme
    assert "cross-tool:" not in readme
    assert "install the cross toolchain manually" not in readme.lower()
    assert "target-capabilities-json" in readme
    assert "Aliases such as `macos-arm` are not accepted" in readme


def test_default_soldr_version_is_one_public_constant() -> None:
    manifest = yaml.safe_load(ACTION_PATH.read_text(encoding="utf-8"))
    version = manifest["inputs"]["version"]["default"]
    readme = README_PATH.read_text(encoding="utf-8")
    contract = CONTRACT_PATH.read_text(encoding="utf-8")

    assert version == "0.9.0"
    assert f"The default Soldr version is `{version}`." in readme
    assert f'EXPECTED_SOLDR_DEFAULT_VERSION = "{version}"' in contract


def test_cross_prepare_matrix_records_every_blessed_target_contract() -> None:
    workflow = yaml.safe_load(CROSS_WORKFLOW_PATH.read_text(encoding="utf-8"))
    job = workflow["jobs"]["target-contract"]
    cells = job["strategy"]["matrix"]["include"]
    targets = {cell["target"] for cell in cells}
    assert targets == {
        "x86_64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "aarch64-pc-windows-msvc",
        "universal2-apple-darwin",
    }

    setup = next(step for step in job["steps"] if step.get("id") == "setup")
    assert setup["uses"] == "./"
    assert setup["with"]["cross-targets"] == "${{ matrix.target }}"
    assert setup["with"]["cache"] is False

    text = CROSS_WORKFLOW_PATH.read_text(encoding="utf-8")
    for required in (
        "target-plan-json",
        "target-capabilities-json",
        "target-env-json",
        "soldr build --locked --release",
        "file -b",
        "actions/upload-artifact@v4",
        "SETUP_SOLDR_TOOLCHAIN_TARGETS",
        "compiler-executable",
        "HTTP_PROXY: http://127.0.0.1:9",
    ):
        assert required in text

    assert (SMOKE_FIXTURE_PATH / "Cargo.toml").is_file()
    assert (SMOKE_FIXTURE_PATH / "Cargo.lock").is_file()
    assert (SMOKE_FIXTURE_PATH / "src" / "main.rs").is_file()
