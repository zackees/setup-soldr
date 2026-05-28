// Shared target/ warning detector. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/detect_shared_target_warning.py.
// Emits a ::warning:: when the user's target-dir already contains compiled
// artifacts (a `deps/*.rmeta` file) and the build-cache is in 'once' mode +
// the target-cache is enabled. This warns workflow authors that a subsequent
// `soldr cargo build` may trip on a stale rust-plan.

import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { createLogger } from "./log-utils.js";
import {
  detectSoldrSupportsToolchainSubcommands,
  soldrToolchainDoctor,
  type SoldrExecFn,
} from "./soldr-toolchain-client.js";

const WARNING_MESSAGE =
  "setup-soldr detected a pre-populated shared target directory; a " +
  "subsequent `soldr cargo build` using the same `--target-dir` may fail " +
  "with a missing .rmeta error - see README 'Known limitations'.";

// setup-soldr#239: when target-cache is DISABLED the populated target/ is this
// run's own `soldr cook` output, not a stale plan restored from a prior run,
// so the missing-.rmeta risk does not apply. We still surface the observation,
// but as a notice (informational tray) rather than a warning, so it does not
// flood the warning channel and hide genuine warnings on every job.
const NOTICE_MESSAGE =
  "setup-soldr: target/ already has compiled artifacts (from `soldr cook`). " +
  "target-cache is disabled, so this is the current run's own output and is " +
  "expected - no action needed. (Enable target-cache and you'd get the " +
  "stale-rust-plan warning instead.)";

/**
 * Pure severity decision (setup-soldr#239): a restored stale rust-plan can
 * only collide when target-cache is enabled, so warn then; otherwise the
 * populated target/ is the current run's own cook output → notice.
 */
export function sharedTargetSignalSeverity(targetCacheEnabled: boolean): "warning" | "notice" {
  return targetCacheEnabled ? "warning" : "notice";
}

/**
 * Emit the shared-target signal at the right severity (setup-soldr#239):
 * a `warning` when target-cache is enabled (a restored stale plan really can
 * collide), a quieter `notice` when it is disabled (the populated target/ is
 * just this run's cook output). `via` names the detection path for the log.
 */
function emitSharedTargetSignal(opts: {
  targetCacheEnabled: boolean;
  buildCacheMode: string;
  targetDir: string;
  via: string;
  log: (msg: string) => void;
}): void {
  if (sharedTargetSignalSeverity(opts.targetCacheEnabled) === "warning") {
    core.warning(WARNING_MESSAGE);
    opts.log(
      `shared-target-dir warning emitted for target_dir=${opts.targetDir} ` +
        `build_cache_mode=${opts.buildCacheMode} (${opts.via})`,
    );
  } else {
    core.notice(NOTICE_MESSAGE);
    opts.log(
      `shared-target-dir notice (target-cache disabled) for target_dir=${opts.targetDir} ` +
        `build_cache_mode=${opts.buildCacheMode} (${opts.via})`,
    );
  }
}

/**
 * Recursively scan `dir` for any `deps/` subdirectory containing a `.rmeta`
 * file. Returns true on the first match. Stops the walk early.
 */
export function targetDirHasCompiledArtifacts(targetDir: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetDir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  return scanForDepsRmeta(targetDir);
}

function scanForDepsRmeta(root: string): boolean {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      if (entry.name === "deps") {
        if (depsDirHasRmeta(sub)) return true;
      }
      stack.push(sub);
    }
  }
  return false;
}

function depsDirHasRmeta(depsDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(depsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".rmeta")) return true;
  }
  return false;
}

export function shouldEmitSharedTargetWarning(opts: {
  buildCacheEnabled: boolean;
  buildCacheMode: string;
  targetCacheEnabled: boolean;
  targetDir: string;
}): boolean {
  if (!opts.buildCacheEnabled) return false;
  if ((opts.buildCacheMode ?? "").trim().toLowerCase() !== "once") return false;
  if (!opts.targetCacheEnabled) return false;
  return targetDirHasCompiledArtifacts(opts.targetDir);
}

/**
 * Wave 3.4 (setup-soldr#133): try sourcing the shared-target-warning
 * verdict from `soldr toolchain doctor --json`'s `shared-target-warning`
 * probe. Returns `{ wouldWarn }` on success or `null` when delegation
 * is not possible (binary missing, soldr < 0.7.35, probe missing, etc.).
 *
 * Exported for unit tests.
 */
export async function tryDelegateToSoldrDoctorSharedTargetWarning(opts: {
  soldrPath: string;
  exec?: SoldrExecFn;
  warn?: (msg: string) => void;
}): Promise<{ wouldWarn: boolean; details: Record<string, unknown> } | null> {
  const detected = await detectSoldrSupportsToolchainSubcommands(opts.soldrPath, {
    exec: opts.exec,
    warn: opts.warn,
  });
  if (!detected.supported) return null;
  const doctor = await soldrToolchainDoctor(opts.soldrPath, {
    exec: opts.exec,
    warn: opts.warn,
  });
  if (doctor === null) return null;
  const probe = doctor.probes.find((p) => p.name === "shared-target-warning");
  if (!probe) return null;
  const details = probe.details ?? {};
  // probe.ok semantics: in this probe, `would_warn` is the authoritative
  // signal; some soldr revisions set `ok=false` to mean "the check tripped"
  // (i.e. would_warn=true). Prefer the explicit boolean when present.
  const wouldWarnExplicit = (details as Record<string, unknown>)["would_warn"];
  const wouldWarn =
    typeof wouldWarnExplicit === "boolean" ? wouldWarnExplicit : !probe.ok;
  return { wouldWarn, details };
}

export async function detectSharedTargetWarning(opts: {
  buildCacheEnabled: boolean;
  effectiveTargetCacheEnabled: boolean;
  buildCacheMode: string;
  targetDir: string;
  /**
   * Optional. When set and the soldr binary at this path is >= 0.7.35,
   * the shared-target-warning probe is sourced from
   * `soldr toolchain doctor --json` instead of the in-process scan.
   */
  soldrPath?: string;
}): Promise<void> {
  const logger = createLogger(process.env);
  const targetDir = (opts.targetDir ?? "").trim();
  if (!targetDir) {
    logger.log("shared-target-dir check skipped: no target dir resolved");
    return;
  }

  // Wave 3.4: try delegation if we have a soldr path.
  if (opts.soldrPath) {
    const delegated = await tryDelegateToSoldrDoctorSharedTargetWarning({
      soldrPath: opts.soldrPath,
      warn: (msg) => core.warning(msg),
    });
    if (delegated !== null) {
      if (delegated.wouldWarn) {
        emitSharedTargetSignal({
          targetCacheEnabled: opts.effectiveTargetCacheEnabled,
          buildCacheMode: opts.buildCacheMode,
          targetDir,
          via: "via soldr toolchain doctor",
          log: (m) => logger.log(m),
        });
      } else {
        logger.log(
          `shared-target-dir check clean for target_dir=${targetDir} ` +
            `build_cache_mode=${opts.buildCacheMode} (via soldr toolchain doctor)`,
        );
      }
      return;
    }
  }

  if (
    shouldEmitSharedTargetWarning({
      buildCacheEnabled: opts.buildCacheEnabled,
      buildCacheMode: opts.buildCacheMode,
      targetCacheEnabled: opts.effectiveTargetCacheEnabled,
      targetDir,
    })
  ) {
    emitSharedTargetSignal({
      targetCacheEnabled: opts.effectiveTargetCacheEnabled,
      buildCacheMode: opts.buildCacheMode,
      targetDir,
      via: "in-process scan",
      log: (m) => logger.log(m),
    });
  } else {
    logger.log(
      `shared-target-dir check clean for target_dir=${targetDir} ` +
        `build_cache_mode=${opts.buildCacheMode} ` +
        `build_cache_enabled=${opts.buildCacheEnabled} ` +
        `target_cache_enabled=${opts.effectiveTargetCacheEnabled}`,
    );
  }
}
