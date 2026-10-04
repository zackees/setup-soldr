"""Offline source execution plan; publisher integration remains separate.

Only the trusted host may construct this command. Source-controlled scripts
must never receive the Docker socket or the host action environment. The module authenticates tool staging and constructs separate source-free
prefetch and offline execution plans; host publisher integration is pending.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import hashlib
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
import time
import tomllib
from typing import TypeAlias


TomlValue: TypeAlias = str | int | float | bool | list["TomlValue"] | dict[str, "TomlValue"]
REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"
LLVM_ARCHIVE_SHA256 = "4021cc49d70472122761709e7376835dfc857b5ec77183fa969b5f61d0f13a2f"
RELEASE_ARCHIVE_SHA256 = "00c33d9f0447c3762868f244bad5e6af78a4f9ab848069069450991a743b107f"
SOURCE_CACHE = "/home/builder/.soldr/cache/zccache"
TOOL_DIGESTS: dict[str, str] = {
    "soldr": "70b530c5e0ae6ee9c2fff317874a5e09a430a98eb29e6cb107e0c07b105a2dc2",
    "soldr-daemon": "70b530c5e0ae6ee9c2fff317874a5e09a430a98eb29e6cb107e0c07b105a2dc2",
    "cargo-chef": "d6bf6165d3eab7c8339b30d9d8a634b2cd8f8a012caf6d02626648c0775b193c",
    "crgx": "c46405c57a0d51fe5b5d0fb776618ce33d3c45deff421496231ed37f27c385aa",
}


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
    llvm: Path


@dataclass(frozen=True)
class PrefetchPaths:
    staged: Path
    registry: Path
    tools: Path
    home: Path


@dataclass(frozen=True)
class FileFingerprint:
    name: str
    sha256: str
    bytes: int


@dataclass(frozen=True)
class DirectoryFootprint:
    files: int
    bytes: int
    entries: int


@dataclass(frozen=True)
class PreparedToolchain:
    image: str
    tools: tuple[FileFingerprint, ...]
    llvm_archive: FileFingerprint
    llvm_tree: DirectoryFootprint
    registry_tree: DirectoryFootprint


@dataclass(frozen=True)
class DockerClient:
    binary: Path
    socket: Path
    home: Path
    config: Path


@dataclass(frozen=True)
class ContainerMeasurement:
    return_code: int
    seconds: float
    log_file: str


def client_environment(client: DockerClient) -> dict[str, str]:
    """A fresh client home/config prevents ambient credential helpers too."""
    return {
        "PATH": f"{client.binary.parent}:/usr/bin:/bin",
        "HOME": str(client.home),
        "DOCKER_CONFIG": str(client.config),
        "DOCKER_HOST": f"unix://{client.socket}",
    }


def execute_container(command: tuple[str, ...], client: DockerClient, log: Path) -> ContainerMeasurement:
    """Keep source stdout in an artifact, never in the workflow control stream.

    The image's timeout owns termination of the workload and its namespace;
    host observation is not used to cancel an unrelated Docker resource.
    """
    if command[:2] != ("docker", "run"):
        raise ValueError("container execution requires the reviewed Docker run plan")
    started = time.perf_counter()
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run(
            (str(client.binary), *command[1:]), env=client_environment(client),
            stdout=output, stderr=subprocess.STDOUT, check=False,
        )
    return ContainerMeasurement(result.returncode, time.perf_counter() - started, str(log))


def stage_released_tools(archive: Path, destination: Path, zstd: Path) -> tuple[FileFingerprint, ...]:
    """Authenticate the fixed release before decoding any archive metadata.

    Only a fresh private directory receives the four independently pinned
    executables. Nothing from this release is executed on the publisher host.
    The source container cannot mount the archive or this staging operation.
    """
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("release archive must be a bounded regular file")
    decoder = zstd.resolve(strict=True)
    if not decoder.is_file():
        raise ValueError("release decoder must be an explicit trusted executable")
    with archive.open("rb") as compressed, tempfile.TemporaryFile() as decoded, tempfile.TemporaryFile() as diagnostics:
        if hashlib.file_digest(compressed, "sha256").hexdigest() != RELEASE_ARCHIVE_SHA256:
            raise ValueError("release archive digest mismatch")
        compressed.seek(0)
        result = subprocess.run(
            (str(decoder), "-d", "-c"), stdin=compressed, stdout=decoded,
            stderr=diagnostics, env={"PATH": str(decoder.parent)}, check=False, timeout=30,
        )
        if result.returncode:
            diagnostics.seek(0)
            raise ValueError("release decoding failed: " + diagnostics.read(8192).decode("utf-8", errors="replace"))
        if decoded.tell() > 128 * 1024 * 1024:
            raise ValueError("decoded release archive exceeds size limit")
        decoded.seek(0)
        destination.mkdir(mode=0o700)
        with tarfile.open(fileobj=decoded, mode="r:") as released:
            stage_release_members(released, destination)
    return verify_released_tools(destination)


def stage_release_members(released: tarfile.TarFile, destination: Path) -> None:
    """No generic extraction: flat regular members with exact names only."""
    seen: set[str] = set()
    for member in released:
        if member.name not in (*TOOL_DIGESTS, "manifest.json") or member.name in seen:
            raise ValueError("unexpected or duplicate release member")
        if not member.isfile() or member.size < 0 or member.size > 64 * 1024 * 1024:
            raise ValueError("release members must be bounded regular files")
        seen.add(member.name)
        if member.name == "manifest.json":
            continue
        reader = released.extractfile(member)
        if reader is None:
            raise ValueError("release member has no content")
        with reader, (destination / member.name).open("xb") as output:
            while chunk := reader.read(1024 * 1024):
                output.write(chunk)
        (destination / member.name).chmod(0o755)
    if seen != {*TOOL_DIGESTS, "manifest.json"}:
        raise ValueError("release member inventory is incomplete")


def verify_released_tools(root: Path) -> tuple[FileFingerprint, ...]:
    """Accept only exact files from the digest-verified v0.9.28 GNU archive."""
    if {entry.name for entry in root.iterdir()} != TOOL_DIGESTS.keys():
        raise ValueError("released tool directory contains missing or unexpected executables")
    records: list[FileFingerprint] = []
    for name, expected in TOOL_DIGESTS.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 67108864:
            raise ValueError("released tool must be a bounded regular file")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected:
            raise ValueError("released tool digest mismatch")
        records.append(FileFingerprint(name, digest, path.stat().st_size))
    return tuple(records)


def bounded_footprint(root: Path, max_files: int = 100000, max_bytes: int = 8589934592) -> DirectoryFootprint:
    """Refuse escaping links, special files and oversized prepared tool trees."""
    resolved = root.resolve(strict=True)
    files = 0
    size = 0
    entries = 0
    for path in root.rglob("*"):
        entries += 1
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            target = path.resolve(strict=True)
            if target != resolved and resolved not in target.parents:
                raise ValueError("prepared tree link escapes its owned root")
        elif stat.S_ISREG(metadata.st_mode):
            files += 1
            size += metadata.st_size
        elif not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("prepared tree contains a special file")
        if entries > max_files or size > max_bytes:
            raise ValueError("prepared tree exceeds metadata bounds")
    return DirectoryFootprint(files, size, entries)


def prepared_metadata(paths: PrefetchPaths) -> PreparedToolchain:
    archive = paths.home / ".soldr/cache/catalogue-v2/assets" / LLVM_ARCHIVE_SHA256
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > 1073741824:
        raise ValueError("prepared LLVM archive must be a bounded regular file")
    with archive.open("rb") as data:
        digest = hashlib.file_digest(data, "sha256").hexdigest()
    if digest != LLVM_ARCHIVE_SHA256:
        raise ValueError("prepared LLVM archive digest mismatch")
    llvm = paths.home / ".soldr/bin/llvm-21.1.5"
    return PreparedToolchain(
        BUILDER_IMAGE, verify_released_tools(paths.tools),
        FileFingerprint(archive.name, digest, archive.stat().st_size),
        bounded_footprint(llvm), bounded_footprint(paths.registry),
    )


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
    if source.absolute() != source.resolve(strict=True) or any((source / name).is_symlink() for name in ("Cargo.toml", "Cargo.lock")):
        raise ValueError("source dependency declarations must not use host symlink aliases")
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
    originals = (paths.source, paths.registry, paths.tools, paths.cache, paths.target, paths.llvm)
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

    The runtime verifies released tools and prepared_metadata before this
    phase. Catalogue lookup is disabled only here: all compiler inputs were
    independently pinned and prepared, and no network is permitted. This
    does not disable compilation caching or alter the fetch phase.
    """
    if type(uid) is not int or type(gid) is not int or uid <= 0 or gid <= 0:
        raise ValueError("the source builder requires a non-root numeric identity")
    owned = validated_paths(paths)
    return (
        "docker", "run", "--rm", "--platform=linux/amd64", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", f"--user={uid}:{gid}",
        "--pids-limit=512", "--tmpfs=/tmp:rw,nosuid,nodev,size=1073741824,mode=1777",
        f"--tmpfs=/home/builder:rw,exec,nosuid,nodev,size=536870912,uid={uid},gid={gid}",
        f"--tmpfs=/home/builder/.soldr:rw,exec,nosuid,nodev,size=536870912,uid={uid},gid={gid}",
        f"--tmpfs=/home/builder/.soldr/cache:rw,exec,nosuid,nodev,size=134217728,uid={uid},gid={gid}",
        "--mount", f"type=bind,source={owned.source},target=/source,readonly",
        "--mount", f"type=bind,source={owned.registry},target=/registry,readonly",
        "--mount", f"type=bind,source={owned.tools},target=/tools,readonly",
        "--mount", f"type=bind,source={owned.cache},target={SOURCE_CACHE}",
        "--mount", f"type=bind,source={owned.target},target=/target",
        "--mount", f"type=bind,source={owned.llvm},target=/llvm,readonly",
        "--workdir=/source", "--env=HOME=/home/builder", "--env=CARGO_HOME=/home/builder/cargo",
        "--env=RUSTUP_HOME=/usr/local/rustup", "--env=RUSTUP_TOOLCHAIN=1.98.1",
        "--env=SOLDR_LLVM_DIR=/llvm/hardlinked/bin",
        "--env=SOLDR_MANIFEST_DISABLE=1",
        "--env=CARGO_TARGET_DIR=/target", f"--env=ZCCACHE_CACHE_DIR={SOURCE_CACHE}",
        "--env=PATH=/tools:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--entrypoint=/usr/bin/timeout", BUILDER_IMAGE, "--kill-after=5s", "600s", "/bin/sh", "-ec",
        'mkdir -p "$CARGO_HOME"; ln -s /registry "$CARGO_HOME/registry"; exec "$@"',
        "builder", "soldr", "cargo", "build", "--workspace", "--all-targets", "--locked", "--offline",
    )


def dependency_fetch_command(paths: PrefetchPaths, uid: int, gid: int) -> tuple[str, ...]:
    """Network is allowed only for a source-free, configuration-free stub.

    The caller must use a newly owned empty registry and freshly verified
    released tools. Never call this with a registry writable by prior source.
    """
    if type(uid) is not int or type(gid) is not int or uid <= 0 or gid <= 0:
        raise ValueError("dependency prefetch requires a non-root numeric identity")
    for path in (paths.staged, paths.registry, paths.tools, paths.home):
        if any(character in str(path) for character in (",", "\n", "\r")) or not path.is_dir():
            raise ValueError("unsafe dependency prefetch mount")
    if any(paths.registry.iterdir()) or any(paths.home.iterdir()):
        raise ValueError("dependency prefetch registry must be newly owned and empty")
    expected = {"Cargo.toml", "Cargo.lock", "src"}
    if {item.name for item in paths.staged.iterdir()} != expected or (paths.staged / "src/main.rs").read_text(encoding="utf-8") != "fn main() {}\n":
        raise ValueError("dependency prefetch accepts only trusted staged declarations and stub")
    return (
        "docker", "run", "--rm", "--platform=linux/amd64", "--network=bridge", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", f"--user={uid}:{gid}",
        "--tmpfs=/tmp:rw,nosuid,nodev,size=1073741824,mode=1777",
        "--mount", f"type=bind,source={paths.home.resolve()},target=/home/builder",
        "--mount", f"type=bind,source={paths.staged.resolve()},target=/staged,readonly",
        "--mount", f"type=bind,source={paths.registry.resolve()},target=/registry",
        "--mount", f"type=bind,source={paths.tools.resolve()},target=/tools,readonly",
        "--workdir=/staged", "--env=HOME=/home/builder", "--env=CARGO_HOME=/home/builder/cargo",
        "--env=RUSTUP_HOME=/usr/local/rustup", "--env=RUSTUP_TOOLCHAIN=1.98.1",
        "--env=PATH=/tools:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--entrypoint=/usr/bin/timeout", BUILDER_IMAGE, "--kill-after=5s", "600s", "/bin/sh", "-ec",
        'mkdir -p "$CARGO_HOME"; ln -s /registry "$CARGO_HOME/registry"; exec "$@"',
        "builder", "soldr", "cargo", "fetch", "--locked", "--manifest-path=/staged/Cargo.toml",
    )
