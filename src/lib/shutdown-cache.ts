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
//   1. `soldr cache shutdown` (when available; zackees/soldr#379) is the
//      preferred path. It handles binary resolution, session-end, depgraph
//      flush, log archive, and synchronous daemon exit in a single call.
//   2. `zccache --stop-server` (PATH-resolved) is the fallback for older
//      soldr versions that don't yet expose `cache shutdown`. Works only
//      when zccache happens to be on PATH at post-step time; if not, we
//      log and accept the orphan-kill path.
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
 * Preferred path: `<soldrPath> cache shutdown` (zackees/soldr#379). Falls
 * back to `zccache --stop-server` (PATH-resolved) if soldr doesn't support
 * the subcommand or no soldr path was provided.
 *
 * The post step calls this BEFORE saving the build-cache tarball so the
 * daemon has a chance to flush in-memory state (incl. the dep graph per
 * zackees/zccache#262) and release file locks; the cache pack then sees a
 * quiescent on-disk view.
 */
export async function shutdownCacheDaemons(opts: {
  soldrPath?: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { soldrPath, log } = opts;
  log("shutdown-cache: requesting daemon shutdown (shutdown-cache-on-exit=true)");

  // Path 1: soldr-mediated shutdown (preferred, post-#379).
  if (soldrPath) {
    const result = await runShutdown(
      { label: "soldr", cmd: soldrPath, args: ["cache", "shutdown"] },
      log,
    );
    if (result.status === "ran" && result.code === 0) {
      // Clean shutdown via soldr — done.
      return;
    }
    if (result.status === "ran" && !looksLikeUnknownSubcommand(result.stderr)) {
      // soldr DID handle the call (the subcommand exists) but reported an
      // error. Don't fall back to direct zccache — soldr's error is the
      // authoritative one, and falling back could double-trigger work.
      log(
        `shutdown-cache: soldr cache shutdown returned non-zero with a recognized command; not falling back`,
      );
      return;
    }
    // Otherwise the subcommand isn't supported on this soldr version; fall
    // through to the direct zccache path.
    log(
      `shutdown-cache: soldr cache shutdown not supported on this soldr version; falling back to direct zccache`,
    );
  }

  // Path 2: direct zccache stop (fallback when soldr#379 hasn't shipped, or
  // when no soldr path is available).
  await runShutdown({ label: "zccache", cmd: "zccache", args: ["--stop-server"] }, log);
}
