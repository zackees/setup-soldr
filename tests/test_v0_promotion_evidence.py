"""The promotion verifier refuses absent, failed, and wrong-SHA evidence."""

import importlib.util
import io
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "v0_promotion", ROOT / "scripts/verify-v0-promotion.py"
)
promotion = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(promotion)
SHA = "a" * 40


def evidence(*, contract=True, canary_status="success", pinned_sha=SHA):
    run = {
        "id": 42,
        "head_sha": SHA,
        "head_branch": "main",
        "status": "completed",
        "conclusion": "success",
        "event": "push",
        "path": ".github/workflows/setup-soldr-contract.yml",
        "repository": {"full_name": "zackees/setup-soldr"},
        "html_url": "https://github.com/zackees/setup-soldr/actions/runs/42",
    }
    canary = {
        "id": 43,
        "repository": {"full_name": "FastLED/fbuild"},
        "status": "completed",
        "conclusion": canary_status,
        "html_url": "https://github.com/FastLED/fbuild/actions/runs/43",
    }
    pin = f"zackees/setup-soldr@{pinned_sha}"
    blob = (
        f"Download action repository '{pin}' (SHA:{pinned_sha})\n"
        f"##[group]Run {pin}\n"
    ).encode()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("job.txt", blob)

    def fake_api(path, *, archive=False):
        if path.endswith("git/ref/heads/main"):
            return {"object": {"sha": SHA}}
        if "/workflows/" in path:
            return {"workflow_runs": [run] if contract else []}
        if path.endswith("/logs"):
            return stream.getvalue()
        return canary

    return fake_api


@pytest.mark.parametrize(
    "api,error",
    [
        (evidence(contract=False), "no successful Setup Soldr Contract"),
        (evidence(canary_status="failure"), "did not complete successfully"),
        (evidence(canary_status="cancelled"), "did not complete successfully"),
        (evidence(pinned_sha="b" * 40), "do not prove"),
    ],
)
def test_bad_evidence_fails_closed(api, error):
    with tempfile.TemporaryDirectory() as runner_temp:
        with patch.object(promotion, "api", api), patch.object(
            promotion.subprocess, "check_output", return_value=SHA
        ), patch.dict(promotion.os.environ, {"RUNNER_TEMP": runner_temp}):
            with pytest.raises(ValueError, match=error):
                promotion.verify(SHA, "43")


def test_exact_sha_success_returns_contract_run():
    with tempfile.TemporaryDirectory() as runner_temp:
        with patch.object(promotion, "api", evidence()), patch.object(
            promotion.subprocess, "check_output", return_value=SHA
        ), patch.dict(promotion.os.environ, {"RUNNER_TEMP": runner_temp}):
            assert promotion.verify(SHA, "43") == 42
            assert Path(runner_temp, "v0-contract-run-id").read_text() == "42"
