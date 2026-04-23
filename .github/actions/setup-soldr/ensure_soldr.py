#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from contextlib import closing
from pathlib import Path

from log_utils import log


def _normalize_version(value: str) -> str:
    return value[1:] if value.startswith("v") else value


def _detect_target() -> tuple[str, str, str]:
    machine = platform.machine().lower()
    if machine in {"x86_64", "amd64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    else:
        raise RuntimeError(f"unsupported architecture: {machine}")

    system = platform.system()
    if system == "Linux":
        return f"{arch}-unknown-linux-gnu", "tar.gz", "soldr"
    if system == "Darwin":
        return f"{arch}-apple-darwin", "tar.gz", "soldr"
    if system == "Windows":
        return f"{arch}-pc-windows-msvc", "zip", "soldr.exe"

    raise RuntimeError(f"unsupported operating system: {system}")


def _release_url(repo: str, version: str) -> str:
    if version:
        tag = version if version.startswith("v") else f"v{version}"
        return f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    return f"https://api.github.com/repos/{repo}/releases/latest"


def _source_archive_url(repo: str, ref: str) -> str:
    return f"https://api.github.com/repos/{repo}/zipball/{ref}"


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


def _fetch_release(repo: str, version: str) -> dict[str, object]:
    request = urllib.request.Request(
        _release_url(repo, version),
        headers=_request_headers(),
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def _resolve_ref_commit_sha(repo: str, ref: str) -> str:
    encoded_ref = urllib.parse.quote(ref, safe="")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/commits/{encoded_ref}",
        headers=_request_headers(),
    )
    with urllib.request.urlopen(request) as response:
        payload = json.load(response)
    commit_sha = payload.get("sha")
    if not isinstance(commit_sha, str) or not commit_sha:
        raise RuntimeError(f"failed to resolve commit sha for {repo}@{ref}")
    return commit_sha


def _installed_version(binary_path: Path) -> str | None:
    if not binary_path.exists():
        return None

    output = subprocess.check_output([str(binary_path), "version", "--json"], text=True)
    payload = json.loads(output)
    return str(payload["soldr_version"])


def _source_metadata_path(install_dir: Path) -> Path:
    return install_dir / ".setup-soldr-source.json"


def _load_source_metadata(path: Path) -> dict[str, str] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return {str(key): str(value) for key, value in payload.items()}


def _write_source_metadata(path: Path, payload: dict[str, str]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _source_install_matches(
    install_dir: Path,
    repo: str,
    ref: str,
    commit_sha: str,
    target: str,
    binary_name: str,
) -> bool:
    binary_path = install_dir / binary_name
    metadata = _load_source_metadata(_source_metadata_path(install_dir))
    if metadata is None or not binary_path.exists():
        return False
    return (
        metadata.get("repo") == repo
        and metadata.get("ref") == ref
        and metadata.get("commit_sha") == commit_sha
        and metadata.get("target") == target
        and metadata.get("binary_name") == binary_name
    )


def _select_asset(release: dict[str, object], target: str, archive_ext: str) -> tuple[str, str]:
    assets = release.get("assets") or []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get("name", ""))
        if target in name and name.endswith(archive_ext):
            return name, str(asset["browser_download_url"])
    raise RuntimeError(f"no release asset found for target {target}")


def _extract_binary(archive_path: Path, archive_ext: str, binary_name: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    if archive_ext == "zip":
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(out_dir)
    else:
        with tarfile.open(archive_path, "r:gz") as archive:
            archive.extractall(out_dir)

    for candidate in out_dir.rglob(binary_name):
        if candidate.is_file():
            return candidate
    raise RuntimeError(f"downloaded archive did not contain {binary_name}")


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers=_request_headers())
    with closing(urllib.request.urlopen(request)) as response, destination.open("wb") as fh:
        shutil.copyfileobj(response, fh)


def _extract_repo_root(archive_path: Path, out_dir: Path) -> Path:
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(out_dir)
    directories = [path for path in out_dir.iterdir() if path.is_dir()]
    if len(directories) != 1:
        raise RuntimeError("source archive did not contain exactly one repository root")
    return directories[0]


def _build_from_source(
    repo: str,
    ref: str,
    commit_sha: str,
    install_dir: Path,
    target: str,
    binary_name: str,
) -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        archive_path = tmp_dir / "source.zip"
        source_root = tmp_dir / "source"
        log(f"Downloading soldr source from {repo}@{ref} ({commit_sha})")
        _download(_source_archive_url(repo, commit_sha), archive_path)
        repo_root = _extract_repo_root(archive_path, source_root)
        env = os.environ.copy()
        env["CARGO_TERM_COLOR"] = env.get("CARGO_TERM_COLOR", "always")
        command = [
            "cargo",
            "build",
            "--locked",
            "--bin",
            "soldr",
            "--target",
            target,
        ]
        log(f"Building soldr from source ref {ref} ({commit_sha})")
        subprocess.check_call(command, cwd=repo_root, env=env)
        built_binary = repo_root / "target" / target / "debug" / binary_name
        if not built_binary.exists():
            raise RuntimeError(f"built soldr binary not found at {built_binary}")
        destination = install_dir / binary_name
        shutil.copy2(built_binary, destination)
        if os.name != "nt":
            destination.chmod(
                destination.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
            )
        _write_source_metadata(
            _source_metadata_path(install_dir),
            {
                "repo": repo,
                "ref": ref,
                "commit_sha": commit_sha,
                "target": target,
                "binary_name": binary_name,
            },
        )
        return destination


def main() -> None:
    install_dir = Path(os.environ["SOLDR_INSTALL_DIR"])
    install_dir.mkdir(parents=True, exist_ok=True)
    target, archive_ext, binary_name = _detect_target()
    binary_path = install_dir / binary_name
    requested_version = os.environ.get("SETUP_SOLDR_VERSION", "").strip()
    requested_ref = os.environ.get("SOLDR_REF", "").strip()
    repo = os.environ.get("SOLDR_REPO", "zackees/soldr").strip() or "zackees/soldr"

    if requested_ref:
        if requested_version:
            log(f"Ignoring requested release version {requested_version!r} because SOLDR_REF is set")
        requested_commit_sha = _resolve_ref_commit_sha(repo, requested_ref)
        if _source_install_matches(
            install_dir,
            repo,
            requested_ref,
            requested_commit_sha,
            target,
            binary_name,
        ):
            current = _installed_version(binary_path)
            if current is not None:
                log(
                    f"Using cached soldr {current} built from "
                    f"{repo}@{requested_ref} ({requested_commit_sha})"
                )
                output = os.environ.get("GITHUB_OUTPUT")
                if output:
                    with open(output, "a", encoding="utf-8") as fh:
                        fh.write(f"installed_version={current}\n")
                return

        built_path = _build_from_source(
            repo,
            requested_ref,
            requested_commit_sha,
            install_dir,
            target,
            binary_name,
        )
        current = _installed_version(built_path)
        log(
            f"Installed soldr {current or requested_ref} from "
            f"{repo}@{requested_ref} ({requested_commit_sha}) at {built_path}"
        )
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with open(output, "a", encoding="utf-8") as fh:
                fh.write(f"installed_version={(current or requested_ref)}\n")
        return

    current = _installed_version(binary_path)
    if current is not None:
        if not requested_version or _normalize_version(current) == _normalize_version(requested_version):
            log(f"Using cached soldr {current} at {binary_path}")
            output = os.environ.get("GITHUB_OUTPUT")
            if output:
                with open(output, "a", encoding="utf-8") as fh:
                    fh.write(f"installed_version={current}\n")
            return

    log(f"Resolving soldr release from {repo}")
    release = _fetch_release(repo, requested_version)
    asset_name, download_url = _select_asset(release, target, archive_ext)
    tag_name = str(release["tag_name"])

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        archive_path = tmp_dir / asset_name
        extract_dir = tmp_dir / "extract"
        log(f"Downloading {asset_name}")
        urllib.request.urlretrieve(download_url, archive_path)
        source = _extract_binary(archive_path, archive_ext, binary_name, extract_dir)
        shutil.copy2(source, binary_path)
        if os.name != "nt":
            binary_path.chmod(binary_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    metadata_path = _source_metadata_path(install_dir)
    if metadata_path.exists():
        metadata_path.unlink()
    log(f"Installed soldr {tag_name} at {binary_path}")

    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.write(f"installed_version={tag_name}\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, urllib.error.URLError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
