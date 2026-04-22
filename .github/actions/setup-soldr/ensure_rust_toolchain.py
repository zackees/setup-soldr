#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import platform
import stat
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from log_utils import color_force_environment, log, run


def append_github_env(name: str, value: str) -> None:
    output = os.environ.get("GITHUB_ENV")
    if not output:
        return
    with open(output, "a", encoding="utf-8") as fh:
        fh.write(f"{name}={value}\n")


def rustup_init_target_triple() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "windows":
        if machine in {"amd64", "x86_64"}:
            return "x86_64-pc-windows-msvc"
        if machine in {"arm64", "aarch64"}:
            return "aarch64-pc-windows-msvc"
        if machine in {"x86", "i386", "i686"}:
            return "i686-pc-windows-msvc"
    elif system == "darwin":
        if machine in {"arm64", "aarch64"}:
            return "aarch64-apple-darwin"
        if machine in {"amd64", "x86_64"}:
            return "x86_64-apple-darwin"
    elif system == "linux":
        if machine in {"amd64", "x86_64"}:
            return "x86_64-unknown-linux-gnu"
        if machine in {"arm64", "aarch64"}:
            return "aarch64-unknown-linux-gnu"
        if machine in {"x86", "i386", "i686"}:
            return "i686-unknown-linux-gnu"

    raise RuntimeError(f"unsupported platform for rustup bootstrap: {system}/{machine}")


def rustup_init_url() -> str:
    target = rustup_init_target_triple()
    suffix = ".exe" if target.endswith("windows-msvc") else ""
    return f"https://static.rust-lang.org/rustup/dist/{target}/rustup-init{suffix}"


def download_rustup_init(destination_dir: Path) -> Path:
    filename = "rustup-init.exe" if os.name == "nt" else "rustup-init"
    destination = destination_dir / filename
    if destination.exists():
        return destination

    url = rustup_init_url()
    temp_destination = destination.with_name(f"{destination.name}.tmp")
    try:
        log(f"Downloading rustup-init from {url}")
        with urlopen(url) as response, open(temp_destination, "wb") as fh:
            shutil.copyfileobj(response, fh)
        temp_destination.replace(destination)
    except (OSError, URLError) as exc:
        if temp_destination.exists():
            temp_destination.unlink()
        raise RuntimeError(f"setup-soldr failed to download rustup-init from {url}: {exc}") from exc

    if os.name != "nt":
        destination.chmod(destination.stat().st_mode | stat.S_IEXEC)

    return destination


def ensure_rustup_available(soldr_root: Path) -> str:
    rustup = shutil.which("rustup")
    if rustup is not None:
        log(f"Using rustup at {rustup}")
        return rustup

    installer_dir = soldr_root / "cache"
    installer_dir.mkdir(parents=True, exist_ok=True)
    installer = download_rustup_init(installer_dir)
    run([str(installer), "-y", "--no-modify-path", "--default-toolchain", "none"])

    rustup = shutil.which("rustup")
    if rustup is None:
        sys.exit("setup-soldr failed to bootstrap rustup on the runner")

    return rustup


def toolchain_available(rustup: str, channel: str) -> bool:
    result = subprocess.run(
        [rustup, "toolchain", "list"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    if result.returncode != 0:
        return False

    for raw_line in result.stdout.splitlines():
        installed = raw_line.split(maxsplit=1)[0] if raw_line.strip() else ""
        if installed == channel or installed.startswith(f"{channel}-"):
            return True
    return False


def _json_list_env(name: str) -> list[str]:
    raw_value = os.environ.get(name, "[]")
    try:
        value = json.loads(raw_value)
    except json.JSONDecodeError:
        value = raw_value.split(",")
    if isinstance(value, str):
        values = value.split(",")
    elif isinstance(value, list):
        values = value
    else:
        return []

    normalized: list[str] = []
    seen: set[str] = set()
    for item in values:
        item = str(item).strip()
        if item and item not in seen:
            normalized.append(item)
            seen.add(item)
    return normalized


def _rustup_installed_names(rustup: str, args: list[str]) -> set[str]:
    result = subprocess.run(
        [rustup, *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    if result.returncode != 0:
        return set()
    return {
        line.split(maxsplit=1)[0]
        for line in result.stdout.splitlines()
        if line.strip()
    }


def installed_components(rustup: str, channel: str) -> set[str]:
    return _rustup_installed_names(
        rustup,
        ["component", "list", "--toolchain", channel, "--installed"],
    )


def installed_targets(rustup: str, channel: str) -> set[str]:
    return _rustup_installed_names(
        rustup,
        ["target", "list", "--toolchain", channel, "--installed"],
    )


def component_is_installed(installed: set[str], component: str) -> bool:
    return any(
        name == component or name.startswith(f"{component}-")
        for name in installed
    )


def missing_components(rustup: str, channel: str, components: list[str]) -> list[str]:
    installed = installed_components(rustup, channel)
    return [
        component
        for component in components
        if not component_is_installed(installed, component)
    ]


def missing_targets(rustup: str, channel: str, targets: list[str]) -> list[str]:
    installed = installed_targets(rustup, channel)
    return [target for target in targets if target not in installed]


def run_captured(command: list[str]) -> None:
    log(f"+ {shlex.join(command)}")
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=color_force_environment(),
    )
    output_lines: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        message = line.rstrip("\n")
        output_lines.append(message)
        log(message)
    returncode = process.wait()
    if returncode != 0:
        raise subprocess.CalledProcessError(
            returncode,
            command,
            output="\n".join(output_lines),
        )


def component_conflict_detected(exc: subprocess.CalledProcessError) -> bool:
    output = str(exc.output or "").lower()
    return "failed to install component" in output and "detected conflict" in output


def remove_components_for_retry(rustup: str, channel: str, components: list[str]) -> None:
    for component in components:
        command = [rustup, "component", "remove", "--toolchain", channel, component]
        try:
            run_captured(command)
        except subprocess.CalledProcessError:
            log(f"Rust component {component} was not removable for {channel}; continuing")


def add_components(rustup: str, channel: str, components: list[str]) -> None:
    if not components:
        return

    missing = missing_components(rustup, channel, components)
    if not missing:
        log(f"Rust components already installed for {channel}: {', '.join(components)}")
        return

    log(f"Installing Rust components for {channel}: {', '.join(missing)}")
    command = [rustup, "component", "add", "--toolchain", channel, *missing]
    try:
        run_captured(command)
    except subprocess.CalledProcessError as exc:
        if not component_conflict_detected(exc):
            raise
        log("Rust component install hit a rustup conflict; removing requested components and retrying")
        remove_components_for_retry(rustup, channel, missing)
        run_captured(command)

    still_missing = missing_components(rustup, channel, components)
    if still_missing:
        raise RuntimeError(
            f"rustup did not install requested components for {channel}: {', '.join(still_missing)}"
        )


def add_targets(rustup: str, channel: str, targets: list[str]) -> None:
    if not targets:
        return

    missing = missing_targets(rustup, channel, targets)
    if not missing:
        log(f"Rust targets already installed for {channel}: {', '.join(targets)}")
        return

    log(f"Installing Rust targets for {channel}: {', '.join(missing)}")
    run([rustup, "target", "add", "--toolchain", channel, *missing])

    still_missing = missing_targets(rustup, channel, targets)
    if still_missing:
        raise RuntimeError(
            f"rustup did not install requested targets for {channel}: {', '.join(still_missing)}"
        )


def main() -> None:
    cargo_home = Path(os.environ["CARGO_HOME"])
    rustup_home = Path(os.environ["RUSTUP_HOME"])
    soldr_root = Path(os.environ["SOLDR_CACHE_DIR"])
    bin_dir = Path(cargo_home / "bin")

    for path in (cargo_home, rustup_home, soldr_root, soldr_root / "cache", soldr_root / "bin", bin_dir):
        path.mkdir(parents=True, exist_ok=True)

    rustup = ensure_rustup_available(soldr_root)

    channel = os.environ.get("SETUP_SOLDR_TOOLCHAIN_CHANNEL", "").strip() or "stable"
    profile = os.environ.get("SETUP_SOLDR_TOOLCHAIN_PROFILE", "").strip() or "minimal"
    components = _json_list_env("SETUP_SOLDR_TOOLCHAIN_COMPONENTS")
    targets = _json_list_env("SETUP_SOLDR_TOOLCHAIN_TARGETS")

    log(f"Resolved Rust toolchain channel={channel} profile={profile}")
    log(f"Requested Rust components: {', '.join(components) if components else 'none'}")
    log(f"Requested Rust targets: {', '.join(targets) if targets else 'none'}")

    run([rustup, "set", "profile", profile])
    if not toolchain_available(rustup, channel):
        log(f"Installing Rust toolchain {channel} with profile {profile}")
        run([rustup, "toolchain", "install", channel, "--profile", profile])
    else:
        log(f"Using installed Rust toolchain {channel}")

    add_components(rustup, channel, components)
    add_targets(rustup, channel, targets)

    os.environ["RUSTUP_TOOLCHAIN"] = channel
    append_github_env("RUSTUP_TOOLCHAIN", channel)

    cargo = shutil.which("cargo")
    rustc = shutil.which("rustc")
    if cargo is None or rustc is None:
        sys.exit(
            "setup-soldr failed to expose cargo/rustc after rustup configured the toolchain"
        )

    run([cargo, "--version"])
    run([rustc, "--version"])

    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.write(f"toolchain={channel}\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
