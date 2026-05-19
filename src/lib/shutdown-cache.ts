// Cache-daemon shutdown helper. Called by the post step when
// `shutdown-cache-on-exit: true`. The point is to flush and close the
// zccache/soldr daemons BEFORE the build-cache tarball is written so
// open file handles aren't holding partially-written entries on disk
// when actions/cache packs them up.
//
// Every shutdown attempt is best-effort: missing binaries, non-zero
// exits, and exec errors are logged and ignored. Failing the post step
// over a daemon cleanup hiccup would lose the user's cache save, which
// is the opposite of what we want.

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
): Promise<{ status: "skipped" | "ran"; code: number | null }> {
  const isAbsolute = /^[\\/]/.test(target.cmd) || /^[A-Za-z]:[\\/]/.test(target.cmd);
  if (!isAbsolute && !(await exists(target.cmd))) {
    log(`shutdown-cache: ${target.label}: '${target.cmd}' not on PATH, skipping`);
    return { status: "skipped", code: null };
  }
  log(`shutdown-cache: ${target.label}: $ ${target.cmd} ${target.args.join(" ")}`);
  try {
    const code = await exec.exec(target.cmd, target.args, {
      ignoreReturnCode: true,
      silent: false,
    });
    if (code !== 0) {
      log(`shutdown-cache: ${target.label}: exit ${code} (ignored — best-effort shutdown)`);
    }
    return { status: "ran", code };
  } catch (err) {
    log(
      `shutdown-cache: ${target.label}: spawn failed (${
        err instanceof Error ? err.message : String(err)
      }); ignoring`,
    );
    return { status: "skipped", code: null };
  }
}

/**
 * Ask any running cache daemons to stop. Best-effort, never throws.
 *
 * Order:
 *   1. zccache --stop-server (sccache CLI convention; zccache is forked
 *      from sccache and follows the same flag).
 *   2. <soldrPath> stop, if a soldr binary path was provided and exists.
 *
 * The post step calls this BEFORE saving the build-cache tarball so
 * the daemon has a chance to flush in-memory state and release file
 * locks; the cache pack then sees a quiescent on-disk view.
 */
export async function shutdownCacheDaemons(opts: {
  soldrPath?: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { soldrPath, log } = opts;
  log("shutdown-cache: requesting daemon shutdown (shutdown-cache-on-exit=true)");

  await runShutdown({ label: "zccache", cmd: "zccache", args: ["--stop-server"] }, log);

  if (soldrPath) {
    await runShutdown({ label: "soldr", cmd: soldrPath, args: ["stop"] }, log);
  }
}
