"""Contracts for the cargo-registry Soldr v2 benchmark and ordering."""

from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "cargo-registry-soldr-benchmark.yml"
SCRIPT = ROOT / "scripts" / "bench-cargo-registry-archives.mjs"
MAIN = ROOT / "src" / "main.ts"
POST = ROOT / "src" / "post.ts"


def _triggers(workflow: dict) -> dict:
    return workflow.get("on") or workflow.get(True)


def test_benchmark_is_manual_windows_2025_with_reproducible_inputs() -> None:
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    triggers = _triggers(workflow)
    assert set(triggers) == {"workflow_dispatch"}
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert inputs["reps"]["default"] == "3"
    assert inputs["runner"]["default"] == "windows-2025"
    assert inputs["file-count"]["default"] == "50000"
    assert inputs["assert-thresholds"]["default"] is False
    job = workflow["jobs"]["benchmark"]
    text = WORKFLOW.read_text(encoding="utf-8")
    assert job["runs-on"] == "${{ inputs.runner }}"
    assert "scripts/bench-cargo-registry-archives.mjs" in text
    assert "if: always()" in text
    assert "actions/upload-artifact@v4" in text
    assert "cargo-registry-archive-benchmark.csv" in text


def test_benchmark_script_has_raw_fields_alternation_validation_and_fixed_gates() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    for field in (
        "runner_os",
        "runner_image",
        "rep",
        "codec_path",
        "archive_bytes",
        "file_count",
        "restore_ms",
        "content_hash",
        "success",
    ):
        assert field in source
    assert "legacy,soldr" in source
    assert "soldr,legacy" in source
    assert "25000" in source
    assert "3 *" in source or "* 3" in source
    assert "content hash" in source.lower()


def test_registry_download_and_post_verify_extraction_are_separate_phases() -> None:
    source = MAIN.read_text(encoding="utf-8")
    parallel = source.index('await markPhase("parallel-restore")')
    verify = source.index('await markPhase("verify")')
    extract = source.index('await markPhase("cargo-registry-extract")')
    cross_prepare = source.index('await markPhase("cross-prepare")')
    assert parallel < verify < extract < cross_prepare
    parallel_block = source[parallel:source.index('await finishPhase("parallel-restore")')]
    registry_download = parallel_block[
        parallel_block.index("const cargoRegistryRestorePromise"):
        parallel_block.index("const blessedPrepareRestorePromise")
    ]
    assert "restoreCacheSafe" in registry_download
    assert "tryLoadViaSoldr" not in registry_download
    assert "decompressCache" not in registry_download
    extract_block = source[extract:cross_prepare]
    assert "restoreCargoRegistryArchive" in extract_block
    assert "soldrRuntimeVersion" in extract_block
    assert "cargo-registry archive extraction failed" in extract_block


def test_post_v2_save_owns_both_archive_paths_without_generic_compression() -> None:
    source = POST.read_text(encoding="utf-8")
    start = source.index(
        'result.cargoRegistryCache.archive.format === "soldr-v2"'
    )
    end = source.index("cargoRegistrySave = await saveOne", start)
    block = source[start:end]
    assert "saveCargoRegistryArchive" in block
    assert "cargoRegistryCache.archive.restorePaths" in block
    assert "cache.saveCache" in block
    assert "compressCache" not in block
    helper = (ROOT / "src" / "lib" / "cargo-registry-archive.ts").read_text(
        encoding="utf-8"
    )
    save_start = helper.index("export async function saveCargoRegistryArchive")
    save_end = helper.index("export async function restoreCargoRegistryArchive")
    assert "saveViaSoldr" in helper[save_start:save_end]
    assert "trySaveViaSoldr" not in helper[save_start:save_end]
    assert "id <= 0" in source
    assert '"race-skip"' in source
