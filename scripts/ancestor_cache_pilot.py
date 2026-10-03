"""Bounded, explicit rust-ci dispatch experiment; not normal CI coverage."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from enum import StrEnum
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Mapping, TypeAlias

JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
WORKLOAD = "scripts/bench-workloads/demo-small"
NAMESPACE = "ancestor-phase1-main-seed-v1"


class PilotMode(StrEnum):
    SEED_LEGACY = "seed-legacy"
    SEED_AUTO = "seed-auto"
    LEGACY = "legacy"
    AUTO = "auto"


@dataclass(frozen=True)
class PilotConfiguration:
    mode: PilotMode
    source_sha: str
    workload: str
    lock_sha256: str
    namespace: str = NAMESPACE
    toolchain: str = "1.98.1"
    soldr: str = "0.9.28"


@dataclass(frozen=True)
class CacheTelemetry:
    selected_cache_id: int | None
    selected_key: str
    identity: str | None
    distance: int | None
    source_sha: str | None
    scan_ms: int | None
    api_ms: int | None
    requests: int | None
    rate_limit_remaining: int | None
    reason: str


@dataclass(frozen=True)
class CompilationStatistics:
    hits: int | None
    misses: int | None
    source: str | None


@dataclass(frozen=True)
class ProcessMeasurement:
    return_code: int
    seconds: float


@dataclass(frozen=True)
class PilotResult:
    configuration: PilotConfiguration
    write_key: str
    matched_key: str
    automatic_donor_restored: bool
    restored_selected_cache_id: int | None
    selection: CacheTelemetry
    rustc_version: str
    soldr_version: str
    build: ProcessMeasurement
    compilation: CompilationStatistics


def checked_command_text(command: tuple[str, ...], cwd: Path) -> str:
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as output:
        subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, check=True)
        output.seek(0)
        return output.read().strip()


def configuration(env: Mapping[str, str], root: Path, source_sha: str) -> PilotConfiguration:
    mode = PilotMode(env.get("PILOT_MODE", ""))
    if env.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise ValueError("the pilot is available only through explicit workflow_dispatch")
    if env.get("GITHUB_REPOSITORY") != "zackees/setup-soldr":
        raise ValueError("this mechanics fixture is scoped to zackees/setup-soldr")
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", source_sha):
        raise ValueError("actual checkout must have a full immutable source SHA")
    if env.get("GITHUB_SHA") != source_sha:
        raise ValueError("actual checkout must match the authenticated workflow source")
    if mode in (PilotMode.SEED_LEGACY, PilotMode.SEED_AUTO) and env.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("seed jobs must actually run in main cache scope")
    if mode is PilotMode.AUTO and not env.get("PILOT_TRUSTED_WRITERS", "").strip():
        raise ValueError("automatic comparison requires reviewed immutable writer jobs")
    lock = root / WORKLOAD / "Cargo.lock"
    return PilotConfiguration(mode, source_sha, WORKLOAD, hashlib.sha256(lock.read_bytes()).hexdigest())


def json_integer(document: dict[str, JsonValue], name: str, *, nullable: bool = False) -> int | None:
    value = document.get(name)
    if value is None and nullable:
        return None
    if type(value) is not int or value < 0:
        raise ValueError(f"invalid integer telemetry: {name}")
    return value


def json_string(document: dict[str, JsonValue], name: str) -> str:
    value = document.get(name)
    if not isinstance(value, str):
        raise ValueError(f"invalid string telemetry: {name}")
    return value


def parse_telemetry(payload: str, source_sha: str, write_key: str) -> CacheTelemetry:
    if not payload:
        return CacheTelemetry(None, "", None, None, None, None, None, None, None, "legacy identity restore")
    document: JsonValue = json.loads(payload)
    if not isinstance(document, dict):
        raise ValueError("ancestor telemetry must be a JSON object")
    if json_string(document, "source_sha") != source_sha or json_string(document, "write_key") != write_key:
        raise ValueError("ancestor telemetry does not describe this actual checkout/write key")
    selected_id = json_integer(document, "selected_cache_id", nullable=True)
    if selected_id == 0:
        raise ValueError("selected cache ID must be positive")
    return CacheTelemetry(
        selected_id,
        json_string(document, "selected_key"), json_string(document, "identity"),
        json_integer(document, "distance", nullable=True), source_sha,
        json_integer(document, "scan_ms"), json_integer(document, "api_ms"),
        json_integer(document, "requests"), json_integer(document, "rate_limit_remaining", nullable=True),
        json_string(document, "reason"),
    )


def selected_donor_restored(telemetry: CacheTelemetry, matched_key: str) -> bool:
    return telemetry.selected_cache_id is not None and bool(telemetry.selected_key) and telemetry.selected_key == matched_key


def compilation_statistics(cache_path: Path, started_ns: int) -> CompilationStatistics:
    archive = cache_path / "logs" / "archive"
    sessions = [item for item in archive.glob("*/last-session-stats.json")
                if item.is_file() and item.stat().st_mtime_ns >= started_ns]
    if not sessions:
        return CompilationStatistics(None, None, None)
    hits = 0
    misses = 0
    try:
        for item in sessions:
            document: JsonValue = json.loads(item.read_text(encoding="utf-8"))
            if not isinstance(document, dict):
                return CompilationStatistics(None, None, str(archive))
            session_hits = json_integer(document, "hits")
            session_misses = json_integer(document, "misses")
            assert session_hits is not None and session_misses is not None
            hits += session_hits
            misses += session_misses
        return CompilationStatistics(hits, misses, str(archive))
    except (OSError, ValueError):
        return CompilationStatistics(None, None, str(archive))


def run_build(root: Path, output: Path) -> ProcessMeasurement:
    started = time.perf_counter()
    with output.open("w", encoding="utf-8") as log:
        process = subprocess.run(("soldr", "cargo", "build", "--workspace", "--all-targets", "--locked"),
                                 cwd=root / WORKLOAD, stdout=log, stderr=subprocess.STDOUT, check=False)
    elapsed = time.perf_counter() - started
    with output.open(encoding="utf-8") as log:
        for line in log:
            print(line, end="", flush=True)
    return ProcessMeasurement(process.returncode, elapsed)


def write_configuration(config: PilotConfiguration, output: Path) -> None:
    auto = config.mode in (PilotMode.SEED_AUTO, PilotMode.AUTO)
    seed = config.mode in (PilotMode.SEED_AUTO, PilotMode.SEED_LEGACY)
    with output.open("a", encoding="utf-8") as stream:
        stream.write(f"key={'auto' if auto else ''}\n")
        stream.write(f"save={'true' if seed else 'false'}\n")
        stream.write(f"namespace={config.namespace}\n")


def measure(config: PilotConfiguration, env: Mapping[str, str], root: Path) -> PilotResult:
    write_key = env.get("PILOT_WRITE_KEY", "")
    if not write_key:
        raise ValueError("the enabled pilot must report its actual write key")
    telemetry = parse_telemetry(env.get("PILOT_ANCESTOR_JSON", ""), config.source_sha, write_key)
    matched_key = env.get("PILOT_MATCHED_KEY", "")
    restored = selected_donor_restored(telemetry, matched_key)
    rustc = checked_command_text(("soldr", "rustc", "--version"), root / WORKLOAD)
    soldr = checked_command_text(("soldr", "--version"), root)
    if not rustc.startswith(f"rustc {config.toolchain} ") or soldr != f"soldr {config.soldr}":
        raise ValueError("actual compiler/builder versions differ from the matched experiment")
    output = root / "ancestor-pilot"
    output.mkdir(exist_ok=True)
    started_ns = time.time_ns()
    build = run_build(root, output / "build.log")
    cache_path = env.get("PILOT_BUILD_CACHE_PATH", "")
    statistics = (compilation_statistics(Path(cache_path), started_ns) if cache_path
                  else CompilationStatistics(None, None, None))
    return PilotResult(config, write_key, matched_key, restored,
                       telemetry.selected_cache_id if restored else None, telemetry, rustc, soldr, build, statistics)


def write_report(result: PilotResult, root: Path, summary_path: Path) -> None:
    document: dict[str, JsonValue] = asdict(result)
    rendered = json.dumps(document, indent=2, sort_keys=True)
    (root / "ancestor-pilot" / "report.json").write_text(rendered + "\n", encoding="utf-8")
    with summary_path.open("a", encoding="utf-8") as summary:
        summary.write("\n### Bounded ancestor mechanics pilot\n\n```json\n" + rendered + "\n```\n")
        summary.write("\nBuild time excludes setup/API/decompression; missing compile telemetry is unknown. "
                      "Post-step upload ID/poison/save gates must be verified from the completed writer job.\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("validate", "measure"))
    arguments = parser.parse_args()
    root = Path.cwd()
    config = configuration(os.environ, root, checked_command_text(("git", "rev-parse", "HEAD"), root))
    if arguments.phase == "validate":
        write_configuration(config, Path(os.environ["GITHUB_OUTPUT"]))
        return 0
    result = measure(config, os.environ, root)
    write_report(result, root, Path(os.environ["GITHUB_STEP_SUMMARY"]))
    if result.build.return_code != 0:
        return result.build.return_code
    if config.mode is PilotMode.AUTO and not result.automatic_donor_restored:
        raise ValueError("automatic experiment did not restore a verified selected donor; see recorded result")
    if config.mode is PilotMode.LEGACY and not result.matched_key:
        raise ValueError("legacy comparison did not restore its seeded control; see recorded result")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
