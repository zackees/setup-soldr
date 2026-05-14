import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";

// Tools that route through `soldr <tool>`:
const ROUTED_TOOLS = ["cargo", "rustfmt", "clippy-driver", "rustc", "rustdoc"];

// Unix bash shim template (per tool):
function bashShim(tool: string, soldrPath: string): string {
  return `#!/usr/bin/env bash
set -e
shim_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
case ":$PATH:" in
  *":$shim_dir:"*)
    PATH="$(printf '%s' ":$PATH:" | sed -e "s|:$shim_dir:|:|g" -e 's|^:||' -e 's|:$||')"
    ;;
esac
export PATH
exec "\${SOLDR_BINARY:-${soldrPath}}" ${tool} "$@"
`;
}

// Windows .cmd shim template (per tool):
function cmdShim(tool: string, soldrPath: string): string {
  return `@echo off
setlocal enableextensions
set "shim_dir=%~dp0"
if "%shim_dir:~-1%"=="\\" set "shim_dir=%shim_dir:~0,-1%"
call set "PATH=%%PATH:%shim_dir%;=%%"
call set "PATH=%%PATH:;%shim_dir%=%%"
call set "PATH=%%PATH:%shim_dir%=%%"
if defined SOLDR_BINARY (
  "%SOLDR_BINARY%" ${tool} %*
) else (
  "${soldrPath}" ${tool} %*
)
endlocal & exit /b %ERRORLEVEL%
`;
}

export async function ensureShims(opts: {
  shimsDir: string;
  soldrPath: string;
  isWindows: boolean;
  log: (msg: string) => void;
}): Promise<void> {
  const { shimsDir, soldrPath, isWindows, log } = opts;
  fs.mkdirSync(shimsDir, { recursive: true });

  for (const tool of ROUTED_TOOLS) {
    if (isWindows) {
      const shimPath = path.join(shimsDir, `${tool}.cmd`);
      fs.writeFileSync(shimPath, cmdShim(tool, soldrPath), "utf8");
      log(`shims: wrote ${shimPath}`);
    } else {
      const shimPath = path.join(shimsDir, tool);
      fs.writeFileSync(shimPath, bashShim(tool, soldrPath), { encoding: "utf8", mode: 0o755 });
      log(`shims: wrote ${shimPath}`);
    }
  }
  core.addPath(shimsDir);
  log(`shims: added ${shimsDir} to PATH`);
}
