"""Offline source execution plan; publisher integration remains separate.

Only the trusted host may construct this command. Source-controlled scripts
must never receive the Docker socket or the host action environment. Registry
prefetch and tool verification are prerequisites, not performed by this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


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
