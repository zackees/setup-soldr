// PATH shim writer.
//
// Writes shim scripts at <shimsDir>/<tool>[.cmd] that forward
// `cargo`/`rustfmt`/`clippy-driver`/`rustc`/`rustdoc` invocations through
// the installed soldr binary so cache-aware tooling is always on PATH.
//
// Wave 3.4 (setup-soldr#133): when the installed soldr binary is >= 0.7.35,
// `ensureShims` delegates the actual shim writing to
// `soldr toolchain link --shim-dir <path> --json`. The legacy in-TS writer
// remains as the fallback for older soldr releases and is exported as
// `ensureShimsLegacy` for unit tests.

import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import {
  detectSoldrSupportsToolchainSubcommands,
  soldrToolchainLink,
  type SoldrExecFn,
  type ToolchainLinkResult,
} from "./soldr-toolchain-client.js";

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

/**
 * Legacy in-process shim writer. Used as the fallback when soldr is
 * older than 0.7.35 (or when the delegation path fails for any reason).
 *
 * Exported for unit tests.
 */
export async function ensureShimsLegacy(opts: {
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

/**
 * Wave 3.4 (setup-soldr#133): try delegating shim creation to
 * `soldr toolchain link --shim-dir <path> --json`. Returns the parsed
 * result on success, or `null` when the binary is missing / older than
 * 0.7.35 / returns a non-1 schema_version / exits non-zero.
 *
 * Exported for unit tests.
 */
export async function tryDelegateToSoldrToolchainLink(opts: {
  soldrPath: string;
  shimDir: string;
  exec?: SoldrExecFn;
  warn?: (msg: string) => void;
}): Promise<ToolchainLinkResult | null> {
  const detected = await detectSoldrSupportsToolchainSubcommands(opts.soldrPath, {
    exec: opts.exec,
    warn: opts.warn,
  });
  if (!detected.supported) return null;
  return soldrToolchainLink(opts.soldrPath, opts.shimDir, {
    exec: opts.exec,
    warn: opts.warn,
  });
}

export async function ensureShims(opts: {
  shimsDir: string;
  soldrPath: string;
  isWindows: boolean;
  log: (msg: string) => void;
}): Promise<void> {
  const { shimsDir, soldrPath, isWindows, log } = opts;
  fs.mkdirSync(shimsDir, { recursive: true });

  // Wave 3.4: try delegating to soldr first. Returns null and we fall back
  // to the legacy writer when the binary is missing or pre-0.7.35.
  const delegated = await tryDelegateToSoldrToolchainLink({
    soldrPath,
    shimDir: shimsDir,
    warn: (msg) => core.warning(msg),
  });
  if (delegated) {
    log(
      `shims: delegated to soldr toolchain link --shim-dir (tools=${delegated.tools.length}, ` +
        `elapsed_ms=${delegated.elapsedMs})`,
    );
    for (const tool of delegated.tools) {
      log(`shims: ${tool.created ? "wrote" : "kept"} ${tool.shimPath}`);
    }
    core.addPath(shimsDir);
    log(`shims: added ${shimsDir} to PATH`);
    return;
  }

  await ensureShimsLegacy({ shimsDir, soldrPath, isWindows, log });
}
