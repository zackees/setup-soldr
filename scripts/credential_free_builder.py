"""Offline source execution plan; publisher integration remains separate.

Only the trusted host may construct this command. Source-controlled scripts
must never receive the Docker socket or the host action environment. Registry
prefetch and tool verification are prerequisites, not performed by this module.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import tomllib
from typing import TypeAlias


TomlValue: TypeAlias = str | int | float | bool | list["TomlValue"] | dict[str, "TomlValue"]
REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"


BUILDER_IMAGE = (
    "docker.io/library/rust@sha256:"
    "c49256cbe5ea0188bc658a689500d70c41eb51f009a7a7be209caf60a944f3ec"
)


@dataclass(frozen=True)
class BuilderPaths:
    source: Path
    registry: Path
    tools: Path
    cache: Path
    target: Path


def dependency_value(value: TomlValue) -> str:
    if isinstance(value, str):
        return json.dumps(value)
    if not isinstance(value, dict):
        raise ValueError("unsupported dependency declaration")
    allowed = {"version", "package", "features", "default-features", "optional"}
    if not value.keys() <= allowed or not isinstance(value.get("version"), str):
        raise ValueError("dependency must use the default registry and an explicit version")
    rendered: list[str] = []
    for key, item in value.items():
        if key in ("default-features", "optional"):
            if type(item) is not bool:
                raise ValueError("dependency flag must be boolean")
        elif key == "features":
            if not isinstance(item, list) or not all(isinstance(feature, str) for feature in item):
                raise ValueError("dependency features must be strings")
        elif not isinstance(item, str):
            raise ValueError("dependency name/version must be strings")
        rendered.append(f"{key} = {json.dumps(item)}")
    return "{ " + ", ".join(rendered) + " }"


def dependency_manifest(document: dict[str, TomlValue]) -> str:
    if not document.keys() <= {"package", "dependencies", "dev-dependencies", "build-dependencies", "bin", "lib"}:
        raise ValueError("pilot prefetch supports only a single registry-dependency package")
    package = document.get("package")
    if not isinstance(package, dict):
        raise ValueError("pilot prefetch requires a package")
    lines = ["[package]"]
    for key in ("name", "version", "edition"):
        value = package.get(key, "2021" if key == "edition" else None)
        if not isinstance(value, str):
            raise ValueError("pilot package identity must use literal strings")
        lines.append(f"{key} = {json.dumps(value)}")
    lines.extend(("build = false", "autobins = false", '[[bin]]', 'name = "prefetch-stub"', 'path = "src/main.rs"'))
    for section in ("dependencies", "dev-dependencies", "build-dependencies"):
        dependencies = document.get(section, {})
        if not isinstance(dependencies, dict):
            raise ValueError("invalid dependency table")
        lines.append(f"[{section}]")
        for name, declaration in dependencies.items():
            lines.append(f"{json.dumps(name)} = {dependency_value(declaration)}")
    return "\n".join(lines) + "\n"


def validate_registry_lock(document: dict[str, TomlValue]) -> None:
    packages = document.get("package", [])
    if not isinstance(packages, list):
        raise ValueError("invalid registry lockfile packages")
    for package in packages:
        if not isinstance(package, dict):
            raise ValueError("invalid registry package record")
        source = package.get("source")
        if source is None:
            continue
        checksum = package.get("checksum")
        if source != REGISTRY_SOURCE or not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("prefetch requires checksum-pinned default registry packages")


def stage_dependency_fixture(source: Path, destination: Path) -> None:
    """Stage declarations and a trusted stub only, never config or source.

    This deliberately supports the single-package mechanics fixture first.
    Workspace/path/git/custom registry graphs fail closed pending a reviewed
    declarative closure implementation; this does not claim production Soldr.
    """
    manifest: dict[str, TomlValue] = tomllib.loads((source / "Cargo.toml").read_text(encoding="utf-8"))
    lock_bytes = (source / "Cargo.lock").read_bytes()
    lock: dict[str, TomlValue] = tomllib.loads(lock_bytes.decode("utf-8"))
    rendered = dependency_manifest(manifest)
    validate_registry_lock(lock)
    destination.mkdir(mode=0o700)
    (destination / "src").mkdir()
    (destination / "Cargo.toml").write_text(rendered, encoding="utf-8")
    (destination / "Cargo.lock").write_bytes(lock_bytes)
    (destination / "src/main.rs").write_text("fn main() {}\n", encoding="utf-8")


def validated_paths(paths: BuilderPaths) -> BuilderPaths:
    originals = (paths.source, paths.registry, paths.tools, paths.cache, paths.target)
    if any(any(character in str(path) for character in (",", "\n", "\r")) for path in originals):
        raise ValueError("unsafe Docker mount path")
    resolved = tuple(path.resolve(strict=True) for path in originals)
    if any(not path.is_dir() or path == Path("/") for path in resolved):
        raise ValueError("mounts must be explicit existing directories")
    for index, path in enumerate(resolved):
        for other in resolved[index + 1:]:
            if path == other or path in other.parents or other in path.parents:
                raise ValueError("builder mounts must be separate, non-overlapping directories")
    return BuilderPaths(*resolved)


def source_build_command(paths: BuilderPaths, uid: int, gid: int) -> tuple[str, ...]:
    """Build source with no network, credentials, socket or writable tools.

    Cargo home is ephemeral; only its registry subtree is restored read-only.
    Thus source cannot plant a credential provider or configuration in a home
    subsequently used by the network-enabled dependency fetch phase.
    """
    if type(uid) is not int or type(gid) is not int or uid <= 0 or gid <= 0:
        raise ValueError("the source builder requires a non-root numeric identity")
    owned = validated_paths(paths)
    return (
        "docker", "run", "--rm", "--platform=linux/amd64", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", f"--user={uid}:{gid}",
        "--pids-limit=512", "--tmpfs=/tmp:rw,nosuid,nodev,size=1073741824,mode=1777",
        f"--tmpfs=/home/builder:rw,nosuid,nodev,size=67108864,uid={uid},gid={gid}",
        "--mount", f"type=bind,source={owned.source},target=/source,readonly",
        "--mount", f"type=bind,source={owned.registry},target=/registry,readonly",
        "--mount", f"type=bind,source={owned.tools},target=/tools,readonly",
        "--mount", f"type=bind,source={owned.cache},target=/cache",
        "--mount", f"type=bind,source={owned.target},target=/target",
        "--workdir=/source", "--env=HOME=/home/builder", "--env=CARGO_HOME=/home/builder/cargo",
        "--env=CARGO_TARGET_DIR=/target", "--env=ZCCACHE_CACHE_DIR=/cache",
        "--env=PATH=/tools:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--entrypoint=/bin/sh", BUILDER_IMAGE, "-ec",
        'mkdir -p "$CARGO_HOME"; ln -s /registry "$CARGO_HOME/registry"; exec "$@"',
        "builder", "soldr", "cargo", "build", "--workspace", "--all-targets", "--locked", "--offline",
    )
