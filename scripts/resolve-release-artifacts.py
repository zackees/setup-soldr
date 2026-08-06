"""Resolve and validate the release lane's explicit artifact allowlist."""

from __future__ import annotations

import glob
import json
import os
from pathlib import Path
import re
import secrets


SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def required(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise SystemExit(f"missing required environment variable {name}")
    return value


def contained(path: Path, root: Path, label: str) -> None:
    try:
        path.relative_to(root)
    except ValueError as error:
        raise SystemExit(f"{label} escapes its allowed directory: {path}") from error


def main() -> None:
    workspace = Path(required("GITHUB_WORKSPACE")).resolve()
    root = (workspace / required("WORKING_DIRECTORY")).resolve()
    contained(root, workspace, "working-directory")

    prefix = required("ARTIFACT_PREFIX")
    target = required("PREPARED_TARGET")
    if not SAFE_NAME.fullmatch(prefix):
        raise SystemExit(
            "artifact-name must start with an alphanumeric character and contain only "
            "letters, digits, '.', '_', or '-' (128 characters maximum)"
        )
    if not SAFE_NAME.fullmatch(target):
        raise SystemExit("prepared target is not safe for an artifact name")
    artifact_name = f"{prefix}-{target}"
    if len(artifact_name) > 255:
        raise SystemExit("resolved artifact name exceeds 255 characters")

    patterns = [line.strip() for line in required("ARTIFACT_PATHS").splitlines() if line.strip()]
    if not patterns:
        raise SystemExit("artifact-paths must contain at least one file or glob")

    resolved: list[Path] = []
    for pattern in patterns:
        if "\r" in pattern or "\n" in pattern or "\0" in pattern:
            raise SystemExit("artifact paths cannot contain control characters")
        if Path(pattern).is_absolute():
            raise SystemExit(f"Artifact path must be relative to working-directory: {pattern}")
        matches: list[Path] = []
        for candidate in glob.glob(str(root / pattern), recursive=True):
            path = Path(candidate).resolve()
            contained(path, root, f"Artifact path/glob {pattern!r}")
            if path.is_file():
                if "\r" in str(path) or "\n" in str(path):
                    raise SystemExit(f"Artifact filename contains a newline and cannot be uploaded safely: {path}")
                matches.append(path)
        if not matches:
            raise SystemExit(f"No release artifacts matched required path/glob: {pattern}")
        resolved.extend(matches)

    unique = list(dict.fromkeys(resolved))
    relative = [path.relative_to(workspace).as_posix() for path in unique]
    delimiter = f"SETUP_SOLDR_RELEASE_PATHS_{secrets.token_hex(16)}"
    while any(str(path) == delimiter for path in unique):
        delimiter = f"SETUP_SOLDR_RELEASE_PATHS_{secrets.token_hex(16)}"

    output = Path(required("GITHUB_OUTPUT"))
    with output.open("a", encoding="utf-8") as handle:
        handle.write(f"artifact-name={artifact_name}\n")
        handle.write(f"resolved-paths<<{delimiter}\n")
        handle.write("\n".join(str(path) for path in unique) + "\n")
        handle.write(f"{delimiter}\n")
        handle.write(f"resolved-json={json.dumps(relative, separators=(',', ':'))}\n")


if __name__ == "__main__":
    main()
