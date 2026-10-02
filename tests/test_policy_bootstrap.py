"""Declarative bootstrap invariants; no workflow activation or native builds."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_tier_contract_has_real_extension_and_reviewed_helper_identity():
    adapter = json.loads((ROOT / "ci/fleet-adapter.v1.json").read_text())
    assert adapter["schema_version"] == 1
    assert re.fullmatch(r"[0-9a-f]{40}", adapter["shared_policy_sha"])
    assert adapter["pin_status"] == "provisional-reviewed-merged"
    assert adapter["label_aliases"] == {}
    assert adapter["docs_jobs"] == adapter["minimal_jobs"]
    assert set(adapter["test_jobs"]) - set(adapter["minimal_jobs"]) == {
        "release-readiness",
        "action-install",
    }
    for key in ("minimal_jobs", "docs_jobs", "test_jobs"):
        assert adapter[key] and len(adapter[key]) == len(set(adapter[key]))


def test_all_supported_targets_require_declared_execution():
    contract = json.loads((ROOT / "ci/fleet-full.v1.json").read_text())
    assert contract["schema_version"] == 1
    targets = {target["triple"]: target for target in contract["targets"]}
    assert len(targets) == len(contract["targets"]) == 8
    assert set(targets) == {
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
        "aarch64-unknown-linux-musl",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "aarch64-pc-windows-msvc",
    }
    required = set(contract["required_jobs"])
    assert len(required) == len(contract["required_jobs"]) == 7
    for triple, target in targets.items():
        assert target["ci"]["build_job"] in required
        assert target["ci"]["run_job"] in required
        if triple == "aarch64-unknown-linux-musl":
            assert target["ci"]["run_job"] == "cross-prepare"
            assert "status" not in target
