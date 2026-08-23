"""Assert a restored closure produces compile-cache hits, never third-party misses.

The sibling `assert_warm.py` runs with the compile cache DISABLED, so the only
thing that can make its warm build fast is the rematerialized closure. This one
is the opposite question: with the cache ENABLED, does the restored state
actually get *used*?

Two independent sources are read, because either alone can lie:

* Cargo's `--message-format=json` stream says which units it considered fresh.
  A unit Cargo never rebuilds emits no rustc invocation at all, so it can never
  appear as a cache miss -- "no miss" from the cache log alone would be
  satisfied by a build that did nothing.
* soldr's own `soldr[cache] <crate> [HIT!]` / `[MISS]` lines say what happened
  to the units that *did* invoke rustc.

The contract: every third-party package is either fresh (never compiled) or a
cache HIT. The only permitted MISS is the workspace crate under test.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# soldr paints the tags, so the raw log carries SGR escapes.
ANSI = re.compile(r"\x1b\[[0-9;]*m")
CACHE_LINE = re.compile(r"soldr\[cache\] (\S+) \[(HIT!|MISS)\]")
SUMMARY = re.compile(
    r"soldr: cache (\d+) HIT, (\d+) MISS \((\d+)% hit rate, saved ([\d.]+)s\)"
)


def normalize(name: str) -> str:
    """Cargo package names use hyphens; rustc `--crate-name` uses underscores."""
    return name.replace("-", "_")


def package_name(package_id: str) -> str:
    """`registry+https://...#serde@1.0.229` -> `serde`; also handles `name@ver`."""
    tail = package_id.rsplit("#", 1)[-1]
    if "@" in tail:
        tail = tail.rsplit("@", 1)[0]
    # A path id can end in `#1.2.3` with the name earlier in the URL.
    if not tail or tail[0].isdigit():
        tail = package_id.rsplit("/", 1)[-1].split("#", 1)[0]
    return tail


def main() -> int:
    messages_path, stderr_path, report_path = (Path(a) for a in sys.argv[1:4])

    workspace_pkgs: set[str] = set()
    external_pkgs: set[str] = set()
    external_dirty: list[str] = []
    workspace_dirty: list[str] = []

    for raw in messages_path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw or not raw.startswith("{"):
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("reason") != "compiler-artifact":
            continue
        pkg_id = msg.get("package_id", "")
        name = normalize(package_name(pkg_id))
        is_workspace = pkg_id.startswith("path+")
        (workspace_pkgs if is_workspace else external_pkgs).add(name)
        if not msg.get("fresh", False):
            (workspace_dirty if is_workspace else external_dirty).append(name)

    stderr_text = ANSI.sub("", stderr_path.read_text(encoding="utf-8", errors="replace"))

    hits: list[str] = []
    misses: list[str] = []
    for crate, outcome in CACHE_LINE.findall(stderr_text):
        (hits if outcome == "HIT!" else misses).append(crate)

    summary_match = SUMMARY.search(stderr_text)
    summary = None
    if summary_match:
        summary = {
            "hits": int(summary_match.group(1)),
            "misses": int(summary_match.group(2)),
            "hit_rate_pct": int(summary_match.group(3)),
            "saved_s": float(summary_match.group(4)),
            "line": summary_match.group(0),
        }

    # rustc names every build script `build_script_build`, so a cache line
    # alone cannot say which package it belongs to. Recover the owner from the
    # `-vv` invocation, which carries CARGO_MANIFEST_DIR/CARGO_PKG_NAME, rather
    # than assuming: the workspace fixture has its own build.rs and *should*
    # recompile, while a third-party build script recompiling is the
    # soldr#2756 false-hit bug this suite exists to catch.
    build_script_owners: set[str] = set()
    for line in stderr_text.splitlines():
        if "build_script_build" not in line:
            continue
        owner = re.search(r"CARGO_MANIFEST_DIR=(\S+)", line)
        if owner:
            build_script_owners.add(owner.group(1))
    external_build_script_owners = sorted(
        d for d in build_script_owners if not d.startswith("/workspace")
    )

    workspace_names = workspace_pkgs or {"cook_rematerialization_fixture"}
    third_party_misses = sorted(
        {m for m in misses if m not in workspace_names and m != "build_script_build"}
    )
    # A build-script miss is only a third-party miss if some build script in
    # this build belonged to a third party. If every invocation came from
    # /workspace, the miss is the project's own build.rs -- which is the one
    # thing that is supposed to rebuild.
    build_script_misses = sorted(
        {m for m in misses if m == "build_script_build"}
    ) if external_build_script_owners else []

    report = {
        "schema_version": 1,
        "cache_enabled": True,
        "summary": summary,
        "cache_hits": sorted(set(hits)),
        "cache_misses": sorted(set(misses)),
        "third_party_misses": third_party_misses,
        "build_script_misses": build_script_misses,
        "build_script_owners": sorted(build_script_owners),
        "external_build_script_owners": external_build_script_owners,
        "external_packages_seen": len(external_pkgs),
        "external_dirty": sorted(set(external_dirty)),
        "workspace_packages": sorted(workspace_pkgs),
        "workspace_dirty": sorted(set(workspace_dirty)),
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))

    # The cache information must actually be in the log. Without this, every
    # assertion below is vacuously true on a build that printed nothing.
    if summary is None:
        raise SystemExit(
            "no `soldr: cache N HIT, M MISS (...)` summary in the build log -- "
            "the cache states were suppressed or the cache never engaged"
        )
    if not hits and not misses:
        raise SystemExit(
            "no per-unit `soldr[cache]` lines in the build log; nothing to verify"
        )

    if external_dirty:
        raise SystemExit(f"third-party packages were rebuilt, not reused: {external_dirty}")
    if third_party_misses:
        raise SystemExit(f"third-party compile-cache MISS: {third_party_misses}")
    if build_script_misses:
        raise SystemExit(
            "a third-party build script recompiled with a cache MISS; the "
            f"cooked closure should have carried its executable. Owners: "
            f"{external_build_script_owners}"
        )
    if not workspace_dirty:
        raise SystemExit(
            "the workspace crate was fresh -- this build verified nothing, the "
            "project source must actually compile"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
