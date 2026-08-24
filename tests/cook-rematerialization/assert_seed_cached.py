"""Assert the seed actually produced archive events on disk.

`test -s` is not enough. The CARGO_HOME defect this suite already hit produced
a 104-byte archive holding zero entries, which is non-empty and therefore
passed `test -s` while carrying nothing. An archive event has to be checked by
what it claims to contain, not by whether a file appeared.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# name -> (minimum entries, minimum bytes on disk)
EXPECTED = {
    "cook": (100, 1_000_000),
    "registry": (100, 1_000_000),
    "zccache": (1, 1_000),
}


def main() -> int:
    artifact = Path(sys.argv[1])
    failures: list[str] = []

    for name, (min_entries, min_bytes) in EXPECTED.items():
        save_json = artifact / f"save-{name}.json"
        archive = artifact / f"{name}.tar.zst"

        if not save_json.is_file():
            failures.append(f"{name}: no save event recorded ({save_json.name} missing)")
            continue
        # `soldr save --json` prints one JSON object; tee may add nothing else.
        payload = json.loads(
            next(
                line
                for line in save_json.read_text(encoding="utf-8").splitlines()
                if line.strip().startswith("{")
            )
        )
        entries = int(payload.get("cache_files", 0)) + int(payload.get("source_files", 0))
        if entries < min_entries:
            failures.append(
                f"{name}: archive event claims {entries} entries, expected >= {min_entries} "
                f"(payload={payload})"
            )

        if not archive.is_file():
            failures.append(f"{name}: archive not written to the drive location")
            continue
        size = archive.stat().st_size
        if size < min_bytes:
            failures.append(f"{name}: archive is {size} bytes, expected >= {min_bytes}")

    print(json.dumps({"archives_checked": sorted(EXPECTED), "failures": failures}, indent=2))
    if failures:
        raise SystemExit("seed archive events did not hold:\n  " + "\n  ".join(failures))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
