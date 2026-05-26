// Cache-daemon shutdown helper. Called by the post step before cache save and
// by the reusable cleanup action when a workflow needs a mid-job shutdown.
//
// Shutdown is best-effort by default: missing binaries, non-zero exits, and
// exec errors are logged and ignored. Failing the post step over a daemon
// cleanup hiccup would lose the user's cache save, which is the opposite of
// what we want. Mid-job cleanup callers can opt into failOnError so self-build
// workflows fail before tests inherit a live builder daemon.
//
// Ordering rationale:
//   1. `soldr cache shutdown` (zackees/soldr#379) is the preferred path. It
//      handles binary resolution, session-end, depgraph flush, log archive,
//      and synchronous daemon exit in a single call. When `logsArchiveDir` is
//      supplied we pass it through as `--archive-logs <dir>` so per-session log
//      subdirectories accumulate inside the build-cache tree and ride the cache
//      cycle.
//   2. `zccache stop` (PATH-resolved) is the compatibility fallback for older
//      soldr versions that do not expose `cache shutdown`. The fallback is
//      still scoped by the caller's `ZCCACHE_CACHE_DIR` environment.
//
// We deliberately do NOT fall back to `soldr stop`: that subcommand does not
// exist, and older soldr versions interpret unknown subcommand names as a
// tool-fetch request. See zackees/setup-soldr#126.

import * as exec from "@actions/exec";
import * as io from "@actions/io";

interface ShutdownTarget {
  /** Display name in logs. */
  label: string;
  /** Command name OR absolute path; subject to PATH lookup when not absolute. */
  cmd: string;
  args: string[];
}

interface ShutdownRunResult {
  status: "skipped" | "ran";
  code: number | null;
  stderr: string;
  failure: string | null;
}

export interface ShutdownCacheDaemonsOptions {
  /**
   * Absolute path to the soldr binary resolved by the main step
   * (typically `process.env.SOLDR_BINARY`). When omitted, the helper goes
   * straight to the direct zccache fallback.
   */
  soldrPath?: string;
  /**
   * Optional directory where soldr should stash per-session log copies via
   * `--archive-logs`.
   */
  logsArchiveDir?: string;
  /** Optional timeout forwarded to `soldr cache shutdown`. */
  shutdownTimeoutSeconds?: number;
  /**
   * Throw if no shutdown path succeeds. The post step leaves this unset; the
   * mid-job cleanup action enables it by default.
   */
  failOnError?: boolean;
  log: (msg: string) => void;
}

async function exists(cmd: string): Promise<boolean> {
  try {
    await io.which(cmd, true);
    return true;
  } catch {
    return false;
  }
}

async function runShutdown(
  target: ShutdownTarget,
  log: (msg: string) => void,
): Promise<ShutdownRunResult> {
  const isAbsolute = /^[\\/]/.test(target.cmd) || /^[A-Za-z]:[\\/]/.test(target.cmd);
  if (!isAbsolute && !(await exists(target.cmd))) {
    const failure = `${target.label}: '${target.cmd}' not on PATH`;
    log(`shutdown-cache: ${failure}, skipping`);
    return { status: "skipped", code: null, stderr: "", failure };
  }

  log(`shutdown-cache: ${target.label}: $ ${target.cmd} ${target.args.join(" ")}`);
  let stderrBuf = "";
  try {
    const code = await exec.exec(target.cmd, target.args, {
      ignoreReturnCode: true,
      silent: false,
      listeners: {
        stderr: (data: Buffer) => {
          stderrBuf += data.toString();
        },
      },
    });
    if (code !== 0) {
      log(`shutdown-cache: ${target.label}: exit ${code} (ignored - best-effort shutdown)`);
    }
    return {
      status: "ran",
      code,
      stderr: stderrBuf,
      failure: code === 0 ? null : `${target.label}: exit ${code}`,
    };
  } catch (err) {
    const failure = `${target.label}: spawn failed (${
      err instanceof Error ? err.message : String(err)
    })`;
    log(`shutdown-cache: ${failure}; ignoring`);
    return { status: "skipped", code: null, stderr: "", failure };
  }
}

/**
 * Detect whether a non-zero exit from `soldr cache shutdown` indicates the
 * subcommand simply does not exist on this soldr version, vs a real shutdown
 * failure on a soldr that does support the command.
 */
function looksLikeUnknownSubcommand(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("unrecognized subcommand") ||
    s.includes("unexpected argument 'shutdown'") ||
    s.includes('unexpected argument "shutdown"') ||
    s.includes("unknown subcommand") ||
    s.includes("invalid subcommand") ||
    // soldr's "fetch unknown tool" fallback path (older versions):
    s.includes("tool not found") ||
    s.includes("no release found")
  );
}

/**
 * Ask any running cache daemons to stop. Best-effort by default.
 */
export async function shutdownCacheDaemons(
  opts: ShutdownCacheDaemonsOptions,
): Promise<void> {
  const {
    soldrPath,
    logsArchiveDir,
    shutdownTimeoutSeconds,
    failOnError = false,
    log,
  } = opts;
  log("shutdown-cache: requesting daemon shutdown");

  const failures: string[] = [];
  const rememberFailure = (message: string | null): void => {
    if (message) failures.push(message);
  };
  const failIfRequired = (message: string | null): void => {
    rememberFailure(message);
    if (failOnError) {
      const detail = message || failures.join("; ") || "no shutdown path succeeded";
      throw new Error(`shutdown-cache: ${detail}`);
    }
  };

  // Path 1: soldr-mediated shutdown (preferred, soldr#379).
  if (soldrPath) {
    const args = ["cache", "shutdown"];
    if (logsArchiveDir) {
      args.push("--archive-logs", logsArchiveDir);
    }
    if (shutdownTimeoutSeconds !== undefined) {
      args.push("--shutdown-timeout-seconds", String(shutdownTimeoutSeconds));
    }

    const result = await runShutdown(
      { label: "soldr", cmd: soldrPath, args },
      log,
    );
    if (result.status === "ran" && result.code === 0) {
      return;
    }

    if (result.status === "ran") {
      const looksUnknown =
        result.code === 2 && looksLikeUnknownSubcommand(result.stderr);
      if (!looksUnknown) {
        log(
          `shutdown-cache: soldr cache shutdown exited ${result.code}; ` +
            "continuing best-effort (recognized command, no fallback)",
        );
        failIfRequired(result.failure ?? `soldr cache shutdown exited ${result.code}`);
        return;
      }
      log(
        `shutdown-cache: soldr cache shutdown not supported on this soldr version ` +
          `(exit ${result.code}); falling back to direct zccache`,
      );
    } else {
      rememberFailure(result.failure);
    }
  }

  // Path 2: direct zccache stop (compat fallback for old soldr versions,
  // and the path we take when no soldr binary was wired through).
  const fallback = await runShutdown({ label: "zccache", cmd: "zccache", args: ["stop"] }, log);
  if (fallback.status === "ran" && fallback.code === 0) {
    return;
  }

  failIfRequired(
    fallback.failure ??
      (failures.length > 0 ? failures.join("; ") : "no cache daemon shutdown path succeeded"),
  );
}
