// Cache-daemon shutdown helper. Called by the post step when
// `shutdown-cache-on-exit: true`. The point is to flush and close the
// zccache/soldr daemons BEFORE the build-cache tarball is written so
// open file handles aren't holding partially-written entries on disk
// when actions/cache packs them up, and so the depgraph save (per
// zackees/zccache#262) has a chance to run before the runner's orphan
// cleanup SIGKILLs the daemon.
//
// Every shutdown attempt is best-effort: missing binaries, non-zero
// exits, and exec errors are logged and ignored. Failing the post step
// over a daemon cleanup hiccup would lose the user's cache save, which
// is the opposite of what we want.
//
// Ordering rationale:
//   1. `soldr cache shutdown` (zackees/soldr#379, shipped in soldr 0.7.x)
//      is the preferred path. It handles binary resolution, session-end,
//      depgraph flush, log archive, and synchronous daemon exit in a
//      single call. When `logsArchiveDir` is supplied we pass it through
//      as `--archive-logs <dir>` so per-session log subdirectories
//      accumulate inside the build-cache tree and ride the cache cycle.
//   2. `zccache --stop-server` (PATH-resolved) is the compatibility
//      fallback for older soldr versions (< the release that shipped
//      `cache shutdown`) that don't yet expose the subcommand. We detect
//      that case from soldr's exit code (2) plus an "unrecognized
//      subcommand"-shaped stderr; any other non-zero exit is treated as
//      a real soldr failure and we do NOT double-trigger work via
//      zccache. Works only when zccache happens to be on PATH at
//      post-step time; if not, we log and accept the orphan-kill path.
//
// We deliberately do NOT fall back to `soldr stop`: that subcommand does
// not exist, and soldr interprets unknown subcommand names as a tool-fetch
// request (e.g. `soldr stop` is read as "fetch and run a tool called
// `stop` from `misaka10987/stop`"). See zackees/setup-soldr#126.

import * as exec from "@actions/exec";
import * as io from "@actions/io";

interface ShutdownTarget {
  /** Display name in logs. */
  label: string;
  /** Command name OR absolute path; subject to PATH lookup when not absolute. */
  cmd: string;
  args: string[];
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
): Promise<{ status: "skipped" | "ran"; code: number | null; stderr: string }> {
  const isAbsolute = /^[\\/]/.test(target.cmd) || /^[A-Za-z]:[\\/]/.test(target.cmd);
  if (!isAbsolute && !(await exists(target.cmd))) {
    log(`shutdown-cache: ${target.label}: '${target.cmd}' not on PATH, skipping`);
    return { status: "skipped", code: null, stderr: "" };
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
      log(`shutdown-cache: ${target.label}: exit ${code} (ignored — best-effort shutdown)`);
    }
    return { status: "ran", code, stderr: stderrBuf };
  } catch (err) {
    log(
      `shutdown-cache: ${target.label}: spawn failed (${
        err instanceof Error ? err.message : String(err)
      }); ignoring`,
    );
    return { status: "skipped", code: null, stderr: "" };
  }
}

/**
 * Detect whether a non-zero exit from `soldr cache shutdown` indicates the
 * subcommand simply doesn't exist on this soldr version — vs a real shutdown
 * failure on a soldr that DOES support the command. Used to decide whether
 * to fall back to direct zccache.
 *
 * The canonical signal from clap-based soldr CLIs is exit code 2 with stderr
 * containing "unrecognized subcommand". We also accept a small handful of
 * adjacent phrasings to be robust against minor wording shifts between soldr
 * versions, and against the older tool-fetch-fallback path where soldr
 * interpreted an unknown subcommand as a GitHub release fetch.
 */
function looksLikeUnknownSubcommand(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("unrecognized subcommand") ||
    s.includes("unknown subcommand") ||
    s.includes("invalid subcommand") ||
    // soldr's "fetch unknown tool" fallback path (older versions):
    s.includes("tool not found") ||
    s.includes("no release found")
  );
}

/**
 * Ask any running cache daemons to stop. Best-effort, never throws.
 *
 * Preferred path: `<soldrPath> cache shutdown [--archive-logs <dir>]`
 * (zackees/soldr#379). Falls back to `zccache --stop-server` (PATH-resolved)
 * only when the soldr binary on disk is too old to know the subcommand
 * (clap exit 2 + "unrecognized subcommand" stderr). Any other soldr error
 * is treated as authoritative — we do NOT double-trigger work via the
 * direct zccache path in that case.
 *
 * The post step calls this BEFORE saving the build-cache tarball so the
 * daemon has a chance to flush in-memory state (incl. the dep graph per
 * zackees/zccache#262) and release file locks; the cache pack then sees a
 * quiescent on-disk view. The optional `logsArchiveDir` lets us also have
 * soldr stash the just-ended session's logs under
 * `<dir>/<session-id>/...` so they ride the build-cache save and survive
 * across runs.
 */
export async function shutdownCacheDaemons(opts: {
  /**
   * Absolute path to the soldr binary resolved by the main step
   * (typically `process.env.SOLDR_BINARY`). Optional because passthrough
   * mode and early-failure main-step bailouts can both leave it unset;
   * in those cases we skip the preferred path and go straight to the
   * direct zccache fallback.
   */
  soldrPath?: string;
  /**
   * Optional directory where soldr should stash per-session log copies
   * via `--archive-logs`. Setup-soldr's post step passes
   * `<build-cache>/logs/archive` so they ride the build-cache tarball.
   */
  logsArchiveDir?: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { soldrPath, logsArchiveDir, log } = opts;
  log("shutdown-cache: requesting daemon shutdown (shutdown-cache-on-exit=true)");

  // Path 1: soldr-mediated shutdown (preferred, soldr#379).
  if (soldrPath) {
    const args = ["cache", "shutdown"];
    if (logsArchiveDir) {
      args.push("--archive-logs", logsArchiveDir);
    }
    const result = await runShutdown(
      { label: "soldr", cmd: soldrPath, args },
      log,
    );
    if (result.status === "ran" && result.code === 0) {
      // Clean shutdown via soldr — done.
      return;
    }
    if (result.status === "ran") {
      // Compatibility shim: only fall back when both clap exit code (2)
      // AND stderr text look like "this soldr doesn't know cache shutdown."
      // Any other non-zero exit is a real shutdown failure on a soldr
      // that DOES support the command — falling back would double-trigger
      // work and obscure the real error.
      const looksUnknown =
        result.code === 2 && looksLikeUnknownSubcommand(result.stderr);
      if (!looksUnknown) {
        log(
          `shutdown-cache: soldr cache shutdown exited ${result.code}; ` +
            `continuing best-effort (recognized command, no fallback)`,
        );
        return;
      }
      log(
        `shutdown-cache: soldr cache shutdown not supported on this soldr version ` +
          `(exit ${result.code}); falling back to direct zccache`,
      );
    }
    // result.status === "skipped" (soldrPath was wrong / spawn failed):
    // drop through to the zccache fallback so we still get a chance to
    // close the daemon.
  }

  // Path 2: direct zccache stop (compat fallback for old soldr versions,
  // and the path we take when no soldr binary was wired through).
  await runShutdown({ label: "zccache", cmd: "zccache", args: ["--stop-server"] }, log);
}
