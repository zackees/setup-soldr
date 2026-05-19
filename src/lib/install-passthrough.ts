// Passthrough soldr stub. Written when `enable: false` instead of
// downloading the real soldr binary.
//
// The stub recognizes the small set of subcommands soldr-aware code paths
// query (`version`, `cache`, `status`) and returns stub JSON so verify
// and post don't crash. For anything else, it execs argv[1..] verbatim —
// `soldr cargo build --release` runs as `cargo build --release`.

import * as fs from "node:fs";
import * as path from "node:path";

const STUB_VERSION = "passthrough";

function bashStub(): string {
  return `#!/usr/bin/env bash
# setup-soldr passthrough stub (enable=false). Forwards \`soldr <tool>\`
# to \`<tool>\` and returns stub JSON for soldr-aware subcommands.
set -e
if [ "$#" -eq 0 ]; then
  echo "soldr passthrough stub: no arguments (setup-soldr was invoked with enable=false)" >&2
  exit 0
fi
case "$1" in
  version)
    cat <<'JSON'
{"soldr_version": "${STUB_VERSION}", "managed_zccache_version": null, "setup_soldr_passthrough": true}
JSON
    exit 0
    ;;
  cache)
    cat <<'JSON'
{"status": "ok", "soldr_version": "${STUB_VERSION}", "managed_zccache_version": null, "last_session": null, "rollups": null, "notes": ["setup-soldr enable=false: soldr passthrough stub"]}
JSON
    exit 0
    ;;
  status)
    cat <<'JSON'
{"status": "ok", "setup_soldr_passthrough": true}
JSON
    exit 0
    ;;
  stop)
    # No daemon to stop in passthrough mode; report success so the
    # post-step shutdown-cache helper doesn't log a noisy non-zero exit.
    exit 0
    ;;
  *)
    exec "$@"
    ;;
esac
`;
}

function cmdStub(): string {
  // Windows .cmd shim. Note that newlines must be CRLF for cmd.exe to
  // parse multi-line scripts reliably; we use \r\n explicitly.
  const stubJsonVersion = `{"soldr_version": "${STUB_VERSION}", "managed_zccache_version": null, "setup_soldr_passthrough": true}`;
  const stubJsonCache = `{"status": "ok", "soldr_version": "${STUB_VERSION}", "managed_zccache_version": null, "last_session": null, "rollups": null, "notes": ["setup-soldr enable=false: soldr passthrough stub"]}`;
  const stubJsonStatus = `{"status": "ok", "setup_soldr_passthrough": true}`;
  const lines = [
    "@echo off",
    "setlocal enableextensions",
    'if "%~1"=="" (',
    "  echo soldr passthrough stub: no arguments ^(setup-soldr was invoked with enable=false^) 1^>^&2",
    "  exit /b 0",
    ")",
    'if /I "%~1"=="version" (',
    `  echo ${stubJsonVersion}`,
    "  exit /b 0",
    ")",
    'if /I "%~1"=="cache" (',
    `  echo ${stubJsonCache}`,
    "  exit /b 0",
    ")",
    'if /I "%~1"=="status" (',
    `  echo ${stubJsonStatus}`,
    "  exit /b 0",
    ")",
    'if /I "%~1"=="stop" exit /b 0',
    'set "TOOL=%~1"',
    "shift",
    '"%TOOL%" %*',
    "exit /b %ERRORLEVEL%",
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * Write a passthrough stub at `soldrPath`. On Unix this is a single
 * bash script at `<binDir>/soldr`. On Windows we write TWO files:
 *
 *   - `soldrPath` (ends in `.cmd`) — for cmd.exe, PowerShell, and
 *     @actions/exec calls that route through cross-spawn's .cmd
 *     handling. This is the canonical SOLDR_BINARY.
 *   - `<binDir>/soldr` (no extension) — a bash-flavored stub that Git
 *     Bash / MSYS / WSL resolves when a workflow step running under
 *     `shell: bash` invokes the literal `soldr` command. Without this
 *     companion file, a bash script that runs `soldr cargo build` on
 *     a Windows runner exits 127 with `soldr: command not found`,
 *     because bash on Windows doesn't auto-append `.cmd` to PATH
 *     lookups. See zccache CI run zackees/zccache#307.
 */
export function installPassthrough(opts: {
  soldrPath: string;
  isWindows: boolean;
  log: (msg: string) => void;
}): void {
  const { soldrPath, isWindows, log } = opts;
  fs.mkdirSync(path.dirname(soldrPath), { recursive: true });
  if (isWindows) {
    fs.writeFileSync(soldrPath, cmdStub(), "utf8");
    const bashTwin = path.join(path.dirname(soldrPath), "soldr");
    fs.writeFileSync(bashTwin, bashStub(), "utf8");
    log(
      `setup-soldr: installed passthrough stubs at ${soldrPath} and ${bashTwin} (enable=false)`,
    );
  } else {
    fs.writeFileSync(soldrPath, bashStub(), { encoding: "utf8", mode: 0o755 });
    log(`setup-soldr: installed passthrough stub at ${soldrPath} (enable=false)`);
  }
}

// Exported for tests.
export const _internal = { bashStub, cmdStub, STUB_VERSION };
