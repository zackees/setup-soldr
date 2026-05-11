#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from log_utils import log

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None


_ROLLING_TOOLCHAIN_ALIASES = ("stable", "beta", "nightly")
_MIB = 1024 * 1024
_GIB = 1024 * _MIB
_TARGET_CACHE_SOFT_BUDGETS: dict[str, tuple[int, int]] = {
    "once": (1024 * 1024 * 1024, 8_000),
    "thin": (512 * 1024 * 1024, 4_000),
    "full": (2 * _GIB, 12_000),
}


def _normalize_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return [str(item).strip() for item in value if str(item).strip()]


def load_toolchain_spec(
    workspace: Path,
    toolchain_file: str,
    toolchain_override: str,
) -> dict[str, Any]:
    channel = "stable"
    profile = "minimal"
    components: list[str] = []
    targets: list[str] = []
    source = "default"
    file_hash = "none"

    if toolchain_file:
        path = workspace / toolchain_file
        if path.exists():
            source = str(path.relative_to(workspace))
            file_bytes = path.read_bytes()
            file_hash = hashlib.sha256(file_bytes).hexdigest()[:16]
            if tomllib is None:
                raise RuntimeError("python tomllib support is required for setup-soldr")
            data = tomllib.loads(file_bytes.decode("utf-8"))
            toolchain = data.get("toolchain", {})
            if isinstance(toolchain, dict):
                channel = str(toolchain.get("channel", channel))
                profile = str(toolchain.get("profile", profile))
                components = _normalize_list(toolchain.get("components"))
                targets = _normalize_list(toolchain.get("targets"))

    if toolchain_override:
        channel = toolchain_override.strip()
        source = "input"

    cache_channel = resolve_toolchain_cache_channel(channel)

    return {
        "channel": channel,
        "cache_channel": cache_channel,
        "profile": profile,
        "components": components,
        "targets": targets,
        "source": source,
        "file_hash": file_hash,
    }


def _rolling_toolchain_alias(channel: str) -> str | None:
    normalized = channel.strip().lower()
    for alias in _ROLLING_TOOLCHAIN_ALIASES:
        if normalized == alias:
            return alias
        if normalized.startswith(f"{alias}-") and not re.match(rf"^{alias}-\d", normalized):
            return alias
    return None


def _rust_channel_manifest_release(channel_alias: str) -> str | None:
    if tomllib is None:
        return None

    url = f"https://static.rust-lang.org/dist/channel-rust-{channel_alias}.toml"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            payload = tomllib.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
        log(
            f"Unable to resolve rolling Rust channel {channel_alias} to a release version: {exc}. "
            "Falling back to the requested channel string for cache keying."
        )
        return None

    rust_pkg = payload.get("pkg", {}).get("rust", {})
    if not isinstance(rust_pkg, dict):
        log(
            f"Rust manifest for rolling channel {channel_alias} did not contain pkg.rust metadata. "
            "Falling back to the requested channel string for cache keying."
        )
        return None

    raw_version = str(rust_pkg.get("version", "")).strip()
    if not raw_version:
        log(
            f"Rust manifest for rolling channel {channel_alias} did not contain a version string. "
            "Falling back to the requested channel string for cache keying."
        )
        return None

    return raw_version.split(" ", 1)[0]


def resolve_toolchain_cache_channel(channel: str) -> str:
    alias = _rolling_toolchain_alias(channel)
    if alias is None:
        return channel

    resolved = _rust_channel_manifest_release(alias)
    if resolved:
        return resolved
    return channel


def _sanitize_fragment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "default"


def _short_file_hash(path: Path, missing: str) -> str:
    if not path.exists():
        return missing
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def _resolve_workspace_path(workspace: Path, value: str) -> Path | None:
    cleaned = value.strip()
    if not cleaned:
        return None
    path = Path(cleaned).expanduser()
    if not path.is_absolute():
        path = workspace / path
    return path.resolve()


def _short_json_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]


def _request_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "setup-soldr-action",
    }
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _fetch_release(repo: str, version: str) -> dict[str, Any]:
    if version:
        tag = version if version.startswith("v") else f"v{version}"
        url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    else:
        url = f"https://api.github.com/repos/{repo}/releases/latest"
    request = urllib.request.Request(url, headers=_request_headers())
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise RuntimeError(f"unexpected GitHub release payload for {repo}")
    return payload


def _resolve_soldr_release_version(repo: str, version: str, ref: str) -> str:
    if ref.strip():
        return ""

    requested = version.strip()
    if requested and requested.lower() != "latest":
        return requested if requested.startswith("v") else f"v{requested}"

    release = _fetch_release(repo, "")
    tag_name = str(release.get("tag_name", "")).strip()
    if not tag_name:
        raise RuntimeError(f"failed to resolve latest soldr release tag from {repo}")
    return tag_name


def _workspace_manifest_hash(workspace: Path) -> str:
    hasher = hashlib.sha256()
    matched = False
    ignored_dirs = {".git", "target", ".soldr", "node_modules"}
    for path in sorted(workspace.rglob("Cargo.toml")):
        if any(part in ignored_dirs for part in path.relative_to(workspace).parts):
            continue
        matched = True
        relative = path.relative_to(workspace).as_posix()
        hasher.update(relative.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(path.read_bytes())
        hasher.update(b"\0")
    return hasher.hexdigest()[:16] if matched else "no-manifest"


def _cargo_config_hash(workspace: Path) -> str:
    hasher = hashlib.sha256()
    matched = False
    for relative in (".cargo/config.toml", ".cargo/config"):
        path = workspace / relative
        if path.exists():
            matched = True
            hasher.update(relative.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(path.read_bytes())
            hasher.update(b"\0")
    return hasher.hexdigest()[:16] if matched else "no-config"


def _target_env_hash() -> str:
    relevant: dict[str, str] = {}
    for name, value in os.environ.items():
        if name in {
            "CARGO_BUILD_TARGET",
            "CARGO_ENCODED_RUSTFLAGS",
            "CARGO_TARGET_DIR",
            "RUSTFLAGS",
        } or (name.startswith("CARGO_TARGET_") and name.endswith("_RUSTFLAGS")):
            relevant[name] = value
    return _short_json_hash(relevant)


_TARGET_CACHE_PROFILES = ("thin-v1", "thin-v2")


def normalize_target_cache_profile(value: str) -> str:
    profile = value.strip().lower()
    if not profile:
        return "thin-v1"
    if profile not in _TARGET_CACHE_PROFILES:
        raise RuntimeError(
            f"invalid target-cache-profile {value!r}; expected thin-v1 or thin-v2"
        )
    return profile


_TARGET_CACHE_BOOL_TRUE = {"true", "1", "yes", "on"}
_TARGET_CACHE_BOOL_FALSE = {"false", "0", "no", "off"}


def normalize_target_cache_bool(input_name: str, value: str) -> str | None:
    normalized = value.strip().lower()
    if not normalized:
        return None
    if normalized in _TARGET_CACHE_BOOL_TRUE:
        return "true"
    if normalized in _TARGET_CACHE_BOOL_FALSE:
        return "false"
    raise RuntimeError(
        f"invalid {input_name} {value!r}; expected true, false, 1, 0, yes, no, on, or off"
    )


def _normalize_legacy_target_cache_mode(value: str) -> str:
    mode = value.strip().lower()
    if not mode:
        return ""
    if mode == "hot":
        log("target-cache-mode 'hot' is deprecated; using build-cache-mode 'thin'.")
        return "thin"
    if mode not in {"thin", "full", "off"}:
        raise RuntimeError(
            f"invalid target-cache-mode {value!r}; expected thin, full, or off"
        )
    return mode


def _target_cache_soft_budget(
    target_cache_enabled: bool,
    build_cache_mode: str,
) -> tuple[str, str]:
    if not target_cache_enabled:
        return "", ""

    bytes_budget, files_budget = _TARGET_CACHE_SOFT_BUDGETS[build_cache_mode]
    return str(bytes_budget), str(files_budget)


def normalize_build_cache_mode(
    value: str,
    legacy_target_mode: str = "",
    allow_legacy_translation: bool = True,
) -> str:
    explicit_mode = value.strip().lower()
    mode = explicit_mode or "once"
    if mode not in {"once", "thin", "full"}:
        raise RuntimeError(
            f"invalid build-cache-mode {value!r}; expected once, thin, or full"
        )

    legacy_mode = _normalize_legacy_target_cache_mode(legacy_target_mode)
    if allow_legacy_translation and not explicit_mode and legacy_mode in {"thin", "full"}:
        log(
            f"target-cache-mode '{legacy_mode}' is deprecated; "
            f"translating to build-cache-mode '{legacy_mode}'."
        )
        return legacy_mode
    return mode


def resolve_lockfile_path(workspace: Path, target_cache_path: Path, lockfile_input: str) -> Path | None:
    explicit = _resolve_workspace_path(workspace, lockfile_input)
    if explicit is not None:
        return explicit

    candidates = [
        target_cache_path.parent / "Cargo.lock",
        workspace / "Cargo.lock",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return candidates[0].resolve()


def _path_for_output(workspace: Path, path: Path | None) -> str:
    if path is None:
        return ""
    try:
        return str(path.relative_to(workspace))
    except ValueError:
        return str(path)


def _write_env(name: str, value: str) -> None:
    output = os.environ.get("GITHUB_ENV")
    if not output:
        return
    with open(output, "a", encoding="utf-8") as fh:
        fh.write(f"{name}={value}\n")


def _write_path(value: str) -> None:
    output = os.environ.get("GITHUB_PATH")
    if not output:
        return
    with open(output, "a", encoding="utf-8") as fh:
        fh.write(f"{value}\n")


def _write_outputs(values: dict[str, str]) -> None:
    output = os.environ.get("GITHUB_OUTPUT")
    if not output:
        return
    with open(output, "a", encoding="utf-8") as fh:
        for key, value in values.items():
            if "\n" in value:
                # Use GitHub's heredoc delimiter form for multi-line outputs.
                delimiter = f"ghadelim_{hashlib.sha256(value.encode()).hexdigest()[:16]}"
                fh.write(f"{key}<<{delimiter}\n{value}\n{delimiter}\n")
            else:
                fh.write(f"{key}={value}\n")


def _default_home_dir(name: str) -> Path:
    return (Path.home() / name).resolve()


def _run_rustup_text(command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env=env,
    )


def _rustup_probe_env(cargo_home: Path, rustup_home: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["CARGO_HOME"] = str(cargo_home)
    env["RUSTUP_HOME"] = str(rustup_home)
    return env


def _rustup_installed_names(
    rustup: str,
    args: list[str],
    env: dict[str, str],
) -> set[str]:
    result = _run_rustup_text([rustup, *args], env)
    if result.returncode != 0:
        return set()
    return {
        line.split(maxsplit=1)[0]
        for line in result.stdout.splitlines()
        if line.strip()
    }


def _toolchain_list_contains(installed: set[str], channel: str) -> bool:
    return any(name == channel or name.startswith(f"{channel}-") for name in installed)


def _installed_toolchain_release(
    rustup: str,
    channel: str,
    env: dict[str, str],
) -> str | None:
    result = _run_rustup_text([rustup, "run", channel, "rustc", "--version"], env)
    if result.returncode != 0:
        return None
    match = re.match(r"^rustc\s+([^\s]+)", result.stdout.strip())
    if match is None:
        return None
    return match.group(1)


def _component_installed(installed: set[str], component: str) -> bool:
    return any(name == component or name.startswith(f"{component}-") for name in installed)


def _system_rustup_satisfies_request(
    cargo_home: Path,
    rustup_home: Path,
    toolchain: dict[str, Any],
) -> bool:
    rustup = shutil.which("rustup")
    if rustup is None:
        log("rustup not found on PATH; using managed RUSTUP_HOME under the setup cache root")
        return False

    env = _rustup_probe_env(cargo_home, rustup_home)
    channel = str(toolchain["channel"]).strip() or "stable"
    installed_toolchains = _rustup_installed_names(rustup, ["toolchain", "list"], env)
    if not _toolchain_list_contains(installed_toolchains, channel):
        log(
            f"Runner rustup home {rustup_home} does not already contain toolchain {channel}; "
            "using managed RUSTUP_HOME under the setup cache root"
        )
        return False

    expected_release = str(toolchain.get("cache_channel", "")).strip()
    if _rolling_toolchain_alias(channel) is not None and expected_release:
        installed_release = _installed_toolchain_release(rustup, channel, env)
        if installed_release != expected_release:
            log(
                f"Runner rustup home {rustup_home} has {channel} release "
                f"{installed_release or 'missing'} but exact-hit reuse expects {expected_release}; "
                "using managed RUSTUP_HOME under the setup cache root"
            )
            return False

    components = list(toolchain.get("components", []))
    if components:
        installed_components = _rustup_installed_names(
            rustup,
            ["component", "list", "--toolchain", channel, "--installed"],
            env,
        )
        missing_components = [
            component
            for component in components
            if not _component_installed(installed_components, component)
        ]
        if missing_components:
            log(
                f"Runner rustup home {rustup_home} is missing requested components "
                f"for {channel}: {', '.join(missing_components)}; "
                "using managed RUSTUP_HOME under the setup cache root"
            )
            return False

    targets = list(toolchain.get("targets", []))
    if targets:
        installed_targets = _rustup_installed_names(
            rustup,
            ["target", "list", "--toolchain", channel, "--installed"],
            env,
        )
        missing_targets = [target for target in targets if target not in installed_targets]
        if missing_targets:
            log(
                f"Runner rustup home {rustup_home} is missing requested targets "
                f"for {channel}: {', '.join(missing_targets)}; "
                "using managed RUSTUP_HOME under the setup cache root"
            )
            return False

    log(
        f"Using runner rustup home {rustup_home} for toolchain {channel}; "
        "setup cache stays binary-only without managed rustup"
    )
    return True


def _path_summary(label: str, path: Path) -> None:
    if not path.exists():
        log(f"{label} path={path} exists=false files=0 bytes=0")
        return

    files = 0
    bytes_total = 0
    for item in path.rglob("*"):
        try:
            if item.is_file():
                files += 1
                bytes_total += item.stat().st_size
        except OSError:
            continue
    log(f"{label} path={path} exists=true files={files} bytes={bytes_total}")


def _setup_cache_paths(
    setup_cache_path: Path,
    bin_dir: Path,
    soldr_bin_cache_path: Path,
    rustup_home: Path,
) -> str:
    # Exact-hit warm reuse needs the installed soldr binary plus the soldr-
    # managed helper binaries under soldr/bin. Only add rustup state when this
    # action is managing RUSTUP_HOME under the setup cache root.
    paths = [str(bin_dir), str(soldr_bin_cache_path)]
    try:
        rustup_home.relative_to(setup_cache_path)
    except ValueError:
        return "\n".join(paths)

    paths.extend(
        (
            str(rustup_home / "settings.toml"),
            str(rustup_home / "toolchains"),
            str(rustup_home / "update-hashes"),
        )
    )
    return "\n".join(paths)


def _setup_cache_layout(setup_cache_path: Path, rustup_home: Path) -> str:
    try:
        rustup_home.relative_to(setup_cache_path)
    except ValueError:
        return "bin+soldr-bin"
    return "bin+soldr-bin+rustup"


def main() -> None:
    workspace = Path(os.environ["ACTION_WORKSPACE"]).resolve()
    runner_temp = Path(os.environ.get("RUNNER_TEMP", workspace / ".tmp")).resolve()
    log_start = str(int(time.time()))
    timestamps = os.environ.get("INPUT_TIMESTAMPS", "true").strip() or "true"
    os.environ["SETUP_SOLDR_LOG_START_EPOCH"] = log_start
    os.environ["SETUP_SOLDR_TIMESTAMPS"] = timestamps

    requested_cache_dir = os.environ.get("INPUT_CACHE_DIR", "").strip()
    cache_root = Path(requested_cache_dir).expanduser().resolve() if requested_cache_dir else (
        runner_temp / "setup-soldr"
    )
    # Keep soldr's own cache tree outside the setup cache root so the managed
    # zccache store is not restored through both setup-cache and build-cache.
    soldr_root = cache_root.parent / f"{cache_root.name}-soldr"
    cargo_home = Path(os.environ.get("CARGO_HOME", "")).expanduser().resolve() if os.environ.get("CARGO_HOME") else (
        _default_home_dir(".cargo")
    )
    bin_dir = cache_root / "bin"
    setup_cache_path = cache_root
    soldr_bin_cache_path = soldr_root / "bin"
    zccache_cache_dir = soldr_root / "cache" / "zccache"
    thin_target_cache_bundle_path = cache_root.parent / f"{cache_root.name}-target-thin"
    soldr_binary = "soldr.exe" if os.name == "nt" else "soldr"
    soldr_path = bin_dir / soldr_binary

    toolchain = load_toolchain_spec(
        workspace=workspace,
        toolchain_file=os.environ.get("INPUT_TOOLCHAIN_FILE", "rust-toolchain.toml"),
        toolchain_override=os.environ.get("INPUT_TOOLCHAIN", ""),
    )

    explicit_rustup_home = os.environ.get("RUSTUP_HOME", "").strip()
    if explicit_rustup_home:
        rustup_home = Path(explicit_rustup_home).expanduser().resolve()
        rustup_strategy = "explicit"
    else:
        runner_rustup_home = _default_home_dir(".rustup")
        if _system_rustup_satisfies_request(cargo_home, runner_rustup_home, toolchain):
            rustup_home = runner_rustup_home
            rustup_strategy = "system"
        else:
            rustup_home = cache_root / "rustup-home"
            rustup_strategy = "managed"

    setup_cache_paths = _setup_cache_paths(
        setup_cache_path,
        bin_dir,
        soldr_bin_cache_path,
        rustup_home,
    )
    setup_cache_layout = _setup_cache_layout(setup_cache_path, rustup_home)

    for path in (
        cache_root,
        soldr_root,
        soldr_root / "cache",
        soldr_bin_cache_path,
        cargo_home,
        cargo_home / "bin",
        rustup_home,
        bin_dir,
        zccache_cache_dir,
        thin_target_cache_bundle_path,
    ):
        path.mkdir(parents=True, exist_ok=True)

    soldr_repo = os.environ.get("INPUT_REPO", "zackees/soldr").strip() or "zackees/soldr"
    soldr_ref = os.environ.get("INPUT_REF", "").strip()
    soldr_version_requested = os.environ.get("INPUT_VERSION", "").strip()
    soldr_version_resolved = _resolve_soldr_release_version(
        soldr_repo,
        soldr_version_requested,
        soldr_ref,
    )
    toolchain_signature = {
        "channel": toolchain["cache_channel"],
        "profile": toolchain["profile"],
        "components": toolchain["components"],
        "targets": toolchain["targets"],
        "source": toolchain["source"],
        "file_hash": toolchain["file_hash"],
        "setup_cache_layout": setup_cache_layout,
        "soldr_repo": soldr_repo,
        "soldr_ref": soldr_ref or "release",
        "soldr_version": soldr_version_resolved or soldr_ref or "source-ref",
    }
    digest = hashlib.sha256(
        json.dumps(toolchain_signature, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]
    runner_os = _sanitize_fragment(os.environ.get("ACTION_OS", os.name).lower())
    runner_arch = _sanitize_fragment(os.environ.get("ACTION_ARCH", "unknown").lower())
    # v4 keeps the dedicated zccache build cache separate while restoring only
    # the managed rustup state needed for exact-hit toolchain reuse.
    cache_prefix = f"setup-soldr-v4-{runner_os}-{runner_arch}"
    cache_key = f"{cache_prefix}-{digest}"
    workspace_manifest_hash = _workspace_manifest_hash(workspace)
    cargo_config_hash = _cargo_config_hash(workspace)

    suffix = os.environ.get("INPUT_CACHE_KEY_SUFFIX", "").strip()
    sanitized_suffix = _sanitize_fragment(suffix) if suffix else ""
    if suffix:
        cache_key = f"{cache_key}-{sanitized_suffix}"

    # Build-artifact cache (Soldr-owned zccache compilation cache).
    # Key shape: setup-soldr-buildcache-v1-{os}-{arch}-{toolchain-digest}-{sha}.
    # Pull request runs prefer the base commit cache before falling back through
    # broad lineage keys, while still saving a PR-specific cache under the
    # merge commit SHA for reruns.
    github_sha = os.environ.get("GITHUB_SHA", "").strip() or "nosha"
    parent_sha = os.environ.get("ACTION_PARENT_SHA", "").strip()
    if parent_sha == github_sha:
        parent_sha = ""
    build_cache_prefix = f"setup-soldr-buildcache-v1-{runner_os}-{runner_arch}"
    build_cache_toolchain_prefix = f"{build_cache_prefix}-{digest}-"
    build_cache_key = f"{build_cache_toolchain_prefix}{github_sha}"
    build_cache_parent_key = f"{build_cache_toolchain_prefix}{parent_sha}" if parent_sha else ""

    target_dir_input = os.environ.get("INPUT_TARGET_DIR", "target").strip() or "target"
    target_cache_path = Path(target_dir_input).expanduser()
    if not target_cache_path.is_absolute():
        target_cache_path = workspace / target_cache_path
    target_cache_path = target_cache_path.resolve()
    target_cache_path.mkdir(parents=True, exist_ok=True)
    lockfile_path = resolve_lockfile_path(
        workspace,
        target_cache_path,
        os.environ.get("INPUT_LOCKFILE", ""),
    )
    cargo_lock_hash = _short_file_hash(lockfile_path, "no-lock") if lockfile_path else "no-lock"
    legacy_target_cache_mode = _normalize_legacy_target_cache_mode(
        os.environ.get("INPUT_TARGET_CACHE_MODE", "")
    )
    target_cache_profile = normalize_target_cache_profile(
        os.environ.get("INPUT_TARGET_CACHE_PROFILE", "")
    )
    target_cache_requested = (
        os.environ.get("INPUT_TARGET_CACHE", "true").strip().lower()
        not in {"0", "false", "no", "off"}
        and legacy_target_cache_mode != "off"
    )
    build_cache_mode = normalize_build_cache_mode(
        os.environ.get("INPUT_BUILD_CACHE_MODE", ""),
        legacy_target_cache_mode,
        (
            "INPUT_BUILD_CACHE_MODE" not in os.environ
            or not os.environ.get("INPUT_BUILD_CACHE_MODE", "").strip()
        )
        and target_cache_requested,
    )
    build_cache_enabled = (
        os.environ.get("INPUT_BUILD_CACHE", "true").strip().lower()
        not in {"0", "false", "no", "off"}
    )
    build_cache_runtime_mode = "full" if build_cache_mode == "once" else build_cache_mode
    target_cache_enabled = (
        build_cache_enabled
        and target_cache_requested
    )
    if build_cache_mode == "thin" and cargo_lock_hash == "no-lock":
        log("build-cache-mode 'thin' requires Cargo.lock; target artifact cache disabled.")
        target_cache_enabled = False
    target_cache_budget_bytes, target_cache_budget_files = _target_cache_soft_budget(
        target_cache_enabled,
        build_cache_mode,
    )

    target_shape_hash = _short_json_hash(
        {
            "target_dir": str(target_cache_path),
            "target_dir_input": target_dir_input,
            "target_env": _target_env_hash(),
        }
    )
    target_inputs_hash = _short_json_hash(
        {
            "cargo_config": cargo_config_hash,
            "cargo_lock": cargo_lock_hash,
            "manifest": workspace_manifest_hash,
            "target_shape": target_shape_hash,
            "toolchain": digest,
        }
    )
    lockfile_only_hash = _short_json_hash(
        {
            "cargo_lock": cargo_lock_hash,
            "toolchain": digest,
        }
    )
    target_cache_bundle_path = thin_target_cache_bundle_path

    target_tree_cache_enabled = target_cache_enabled and build_cache_mode == "full"

    if not target_cache_enabled:
        target_cache_paths = ""
        target_cache_effective_mode = "off"
        target_cache_prefix = f"setup-soldr-targetcache-off-v1-{runner_os}-{runner_arch}"
        target_cache_lock_prefix = ""
        target_cache_lockfile_prefix = ""
        target_cache_key = f"{target_cache_prefix}-{target_inputs_hash}"
        target_cache_parent_key = ""
    elif target_tree_cache_enabled:
        # Restore both the full target tree and the separate rust-plan bundle
        # root so soldr/zccache can reuse the local bundle without storing it
        # inside target/ and re-bundling previous bundle contents on save.
        target_cache_paths = "\n".join(
            (
                str(target_cache_path),
                str(target_cache_bundle_path),
            )
        )
        target_cache_effective_mode = build_cache_mode
        target_cache_prefix = (
            f"setup-soldr-targetcache-{build_cache_mode}-v1-{runner_os}-{runner_arch}"
        )
        target_cache_suffix_fragment = f"{sanitized_suffix}-" if sanitized_suffix else ""
        target_cache_lock_prefix = (
            f"{target_cache_prefix}-{digest}-{cargo_lock_hash}-"
            f"{target_shape_hash}-{target_cache_suffix_fragment}"
        )
        target_cache_lockfile_prefix = (
            f"{target_cache_prefix}-{lockfile_only_hash}-{target_cache_suffix_fragment}"
        )
        target_cache_key = f"{target_cache_lock_prefix}{github_sha}"
        target_cache_parent_key = f"{target_cache_lock_prefix}{parent_sha}" if parent_sha else ""
    else:
        target_cache_paths = str(target_cache_bundle_path)
        target_cache_effective_mode = build_cache_mode
        target_cache_prefix = (
            f"setup-soldr-targetcache-{build_cache_mode}-v1-{runner_os}-{runner_arch}"
        )
        target_cache_suffix_fragment = f"{sanitized_suffix}-" if sanitized_suffix else ""
        target_cache_lock_prefix = (
            f"{target_cache_prefix}-{target_inputs_hash}-{target_cache_suffix_fragment}"
        )
        target_cache_lockfile_prefix = (
            f"{target_cache_prefix}-{lockfile_only_hash}-{target_cache_suffix_fragment}"
        )
        target_cache_key = f"{target_cache_lock_prefix}{github_sha}"
        target_cache_parent_key = f"{target_cache_lock_prefix}{parent_sha}" if parent_sha else ""

    if suffix:
        build_cache_key = f"{build_cache_key}-{sanitized_suffix}"
        if build_cache_parent_key:
            build_cache_parent_key = f"{build_cache_parent_key}-{sanitized_suffix}"

    _write_env("SOLDR_CACHE_DIR", str(soldr_root))
    _write_env("CARGO_HOME", str(cargo_home))
    _write_env("RUSTUP_HOME", str(rustup_home))
    _write_env("ZCCACHE_CACHE_DIR", str(zccache_cache_dir))
    _write_env("SETUP_SOLDR_BUILD_CACHE_MODE", build_cache_mode)
    _write_env("SOLDR_BUILD_CACHE_MODE", build_cache_runtime_mode)
    _write_env(
        "SOLDR_TARGET_CACHE_MODE",
        build_cache_runtime_mode if target_cache_enabled else "off",
    )
    _write_env("SOLDR_TARGET_CACHE_DIR", str(target_cache_path))
    _write_env("SOLDR_TARGET_CACHE_BUNDLE_DIR", str(target_cache_bundle_path))
    _write_env("SOLDR_TARGET_CACHE_PROFILE", target_cache_profile)
    target_cache_strip_debuginfo = normalize_target_cache_bool(
        "target-cache-strip-debuginfo",
        os.environ.get("INPUT_TARGET_CACHE_STRIP_DEBUGINFO", ""),
    )
    if target_cache_strip_debuginfo is not None:
        _write_env("SOLDR_TARGET_CACHE_STRIP_DEBUGINFO", target_cache_strip_debuginfo)
    target_cache_include_incremental = normalize_target_cache_bool(
        "target-cache-include-incremental",
        os.environ.get("INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL", ""),
    )
    if target_cache_include_incremental is not None:
        _write_env(
            "SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL",
            target_cache_include_incremental,
        )
    target_cache_include_build_script_binaries = normalize_target_cache_bool(
        "target-cache-include-build-script-binaries",
        os.environ.get("INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES", ""),
    )
    if target_cache_include_build_script_binaries is not None:
        _write_env(
            "SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES",
            target_cache_include_build_script_binaries,
        )
    # setup-soldr already rehydrates the rust-plan bundle directory with
    # actions/cache, so the soldr/zccache layer should operate on that local
    # bundle instead of switching to zccache's separate direct GHA backend.
    _write_env("SOLDR_TARGET_CACHE_BACKEND", "local")
    _write_env("SETUP_SOLDR_TOOLCHAIN_CHANNEL", toolchain["channel"])
    _write_env("SETUP_SOLDR_TOOLCHAIN_CACHE_CHANNEL", toolchain["cache_channel"])
    _write_env("SETUP_SOLDR_TOOLCHAIN_PROFILE", toolchain["profile"])
    _write_env("SETUP_SOLDR_TOOLCHAIN_COMPONENTS", json.dumps(toolchain["components"]))
    _write_env("SETUP_SOLDR_TOOLCHAIN_TARGETS", json.dumps(toolchain["targets"]))
    _write_env("SETUP_SOLDR_LOG_START_EPOCH", log_start)
    _write_env("SETUP_SOLDR_TIMESTAMPS", timestamps)
    if timestamps.lower() not in {"0", "false", "no", "off"} and "NO_COLOR" not in os.environ:
        if not os.environ.get("CARGO_TERM_COLOR"):
            _write_env("CARGO_TERM_COLOR", "always")
        if not os.environ.get("CLICOLOR_FORCE"):
            _write_env("CLICOLOR_FORCE", "1")
        if not os.environ.get("FORCE_COLOR"):
            _write_env("FORCE_COLOR", "1")
    if os.environ.get("INPUT_TRUST_MODE", "").strip():
        _write_env("SOLDR_TRUST_MODE", os.environ["INPUT_TRUST_MODE"].strip())

    _write_path(str(bin_dir))
    _write_path(str(cargo_home / "bin"))

    log("setup-soldr cache plan")
    log(f"cache key={cache_key}")
    log(f"cache restore-key={cache_prefix}-")
    log(f"build-cache key={build_cache_key}")
    log(f"build-cache mode={build_cache_mode}")
    log(f"build-cache soldr-mode={build_cache_runtime_mode}")
    if build_cache_parent_key:
        log(f"build-cache restore-key-parent={build_cache_parent_key}")
    log(f"build-cache restore-key-toolchain={build_cache_toolchain_prefix}")
    log(f"build-cache restore-key-os-arch={build_cache_prefix}-")
    log(f"target-cache key={target_cache_key}")
    log(f"target-cache enabled={str(target_cache_enabled).lower()}")
    log(f"target-cache mode={target_cache_effective_mode}")
    log("target-cache backend=local")
    if target_cache_enabled:
        log(f"target-cache soft-budget-bytes={target_cache_budget_bytes}")
        log(f"target-cache soft-budget-files={target_cache_budget_files}")
    log(f"soldr repo={soldr_repo}")
    log(f"soldr ref={soldr_ref or 'release'}")
    if soldr_version_resolved:
        log(f"soldr version={soldr_version_resolved}")
    log(f"toolchain channel={toolchain['channel']}")
    log(f"toolchain cache-channel={toolchain['cache_channel']}")
    log(f"rustup strategy={rustup_strategy}")
    log(f"setup-cache layout={setup_cache_layout}")
    if target_cache_parent_key:
        log(f"target-cache restore-key-parent={target_cache_parent_key}")
    log(f"target-cache restore-key-lock={target_cache_lock_prefix}")
    log(f"target-cache restore-key-lockfile={target_cache_lockfile_prefix}")
    log(f"target-cache paths={target_cache_paths}")
    log(f"target-cache bundle-dir={target_cache_bundle_path}")
    log(f"target-cache lockfile={_path_for_output(workspace, lockfile_path)}")
    log(f"target-cache lockfile-hash={cargo_lock_hash}")
    _path_summary("cache before restore", setup_cache_path)
    _path_summary("soldr-bin before restore", soldr_bin_cache_path)
    _path_summary("build-cache before restore", zccache_cache_dir)
    _path_summary(
        "target-cache before restore",
        target_cache_path if target_tree_cache_enabled else target_cache_bundle_path,
    )

    _write_outputs(
        {
            "cache_root": str(cache_root),
            "setup_cache_path": str(setup_cache_path),
            "setup_cache_paths": setup_cache_paths,
            "cache_key": cache_key,
            "cache_restore_prefix": f"{cache_prefix}-",
            "build_cache_key": build_cache_key,
            "build_cache_restore_key_parent": build_cache_parent_key,
            "build_cache_restore_key_toolchain": build_cache_toolchain_prefix,
            "build_cache_restore_key_os_arch": f"{build_cache_prefix}-",
            "build_cache_path": str(zccache_cache_dir),
            "build_cache_mode": build_cache_mode,
            "target_cache_path": str(target_cache_path),
            "target_cache_bundle_path": str(target_cache_bundle_path),
            "target_cache_paths": target_cache_paths,
            "target_cache_enabled": str(target_cache_enabled).lower(),
            "target_cache_mode": target_cache_effective_mode,
            "target_cache_profile": target_cache_profile,
            "target_cache_key": target_cache_key,
            "target_cache_restore_key_parent": target_cache_parent_key,
            "target_cache_restore_key_lock": target_cache_lock_prefix,
            "target_cache_restore_key_lockfile": target_cache_lockfile_prefix,
            "target_cache_budget_bytes": target_cache_budget_bytes,
            "target_cache_budget_files": target_cache_budget_files,
            "target_lockfile_path": _path_for_output(workspace, lockfile_path),
            "target_lockfile_hash": cargo_lock_hash,
            "soldr_root": str(soldr_root),
            "soldr_bin_cache_path": str(soldr_bin_cache_path),
            "cargo_home": str(cargo_home),
            "rustup_home": str(rustup_home),
            "setup_cache_layout": setup_cache_layout,
            "bin_dir": str(bin_dir),
            "soldr_path": str(soldr_path),
            "soldr_repo": soldr_repo,
            "soldr_ref": soldr_ref,
            "soldr_version_requested": soldr_version_requested,
            "soldr_version_resolved": soldr_version_resolved,
            "toolchain_channel": toolchain["channel"],
            "toolchain_cache_channel": toolchain["cache_channel"],
            "toolchain_profile": toolchain["profile"],
            "toolchain_source": toolchain["source"],
            "toolchain": toolchain["channel"],
        }
    )


if __name__ == "__main__":
    main()
