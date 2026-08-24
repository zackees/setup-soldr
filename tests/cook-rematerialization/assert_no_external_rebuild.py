"""Assert a warm build rebuilt no independent third-party code.

This is the freshness half of the cook proof, applied to a real workspace
(soldr itself) rather than a synthetic fixture. Deliberately no speedup gate:
soldr's own workspace is large enough that wall-clock is dominated by
workspace compilation, so a ratio would measure the workspace, not the
dependency closure it is supposed to be testing.

Two guards against a vacuous pass, because "no external package rebuilt" is
trivially true of a build that did nothing:

* a minimum external package count -- a build whose dependency graph did not
  resolve would otherwise sail through;
* at least one workspace unit must actually compile.

An optional Cargo metadata file distinguishes registry packages that directly
depend on a local path package. Those packages are workspace-coupled: when a
fresh checkout legitimately rebuilds the local package, Cargo must also rebuild
its registry reverse-dependent. They are reported separately rather than
misdiagnosed as a failed dependency rematerialization.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def package_name(package_id: str) -> str:
    tail = package_id.rsplit("#", 1)[-1]
    if "@" in tail:
        tail = tail.rsplit("@", 1)[0]
    if not tail or tail[0].isdigit():
        tail = package_id.rsplit("/", 1)[-1].split("#", 1)[0]
    return tail


def path_dependent_external_ids(
    metadata_path: Path | None, dirty_path_ids: set[str]
) -> set[str]:
    if metadata_path is None:
        return set()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    packages = {package["id"]: package for package in metadata["packages"]}
    path_ids = {
        package_id
        for package_id, package in packages.items()
        if package.get("source") is None
    }
    return {
        node["id"]
        for node in metadata["resolve"]["nodes"]
        if packages[node["id"]].get("source") is not None
        and path_ids.intersection(dirty_path_ids, node.get("dependencies", []))
    }


def main() -> int:
    messages_path = Path(sys.argv[1])
    report_path = Path(sys.argv[2])
    min_external = int(sys.argv[3]) if len(sys.argv) > 3 else 50
    metadata_path = Path(sys.argv[4]) if len(sys.argv) > 4 else None

    artifacts: list[tuple[str, str, bool, bool]] = []
    for raw in messages_path.read_text(encoding="utf-8", errors="replace").splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("reason") != "compiler-artifact":
            continue
        pkg_id = msg.get("package_id", "")
        artifacts.append(
            (
                pkg_id,
                package_name(pkg_id),
                pkg_id.startswith("path+"),
                bool(msg.get("fresh", False)),
            )
        )

    dirty_path_ids = {
        pkg_id
        for pkg_id, _, is_workspace, fresh in artifacts
        if is_workspace and not fresh
    }
    path_dependent_ids = path_dependent_external_ids(metadata_path, dirty_path_ids)

    external_fresh: set[str] = set()
    external_dirty: set[str] = set()
    path_dependent_dirty: set[str] = set()
    workspace_dirty: set[str] = set()
    workspace_fresh: set[str] = set()

    for pkg_id, name, is_workspace, fresh in artifacts:
        if is_workspace:
            (workspace_fresh if fresh else workspace_dirty).add(name)
        elif not fresh and pkg_id in path_dependent_ids:
            path_dependent_dirty.add(name)
        else:
            (external_fresh if fresh else external_dirty).add(name)

    report = {
        "schema_version": 2,
        "external_fresh_count": len(external_fresh),
        "external_dirty": sorted(external_dirty),
        "external_path_dependent_dirty": sorted(path_dependent_dirty),
        "external_total": len(external_fresh | external_dirty | path_dependent_dirty),
        "workspace_dirty": sorted(workspace_dirty),
        "workspace_fresh_count": len(workspace_fresh),
        "min_external_required": min_external,
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))

    total_external = report["external_total"]
    if total_external < min_external:
        raise SystemExit(
            f"only {total_external} external packages in the build stream "
            f"(expected >= {min_external}); the graph did not resolve, so "
            "'nothing rebuilt' would pass for the wrong reason"
        )
    if external_dirty:
        raise SystemExit(
            f"{len(external_dirty)} third-party packages rebuilt instead of "
            f"rematerializing: {sorted(external_dirty)[:20]}"
        )
    if not workspace_dirty:
        raise SystemExit(
            "no workspace unit compiled; this build verified nothing about "
            "rematerialization because it did no work at all"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
