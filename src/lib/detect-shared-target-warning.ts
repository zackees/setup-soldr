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

const WARNING_MESSAGE =
  "setup-soldr detected a pre-populated shared target directory; a " +
  "subsequent `soldr cargo build` using the same `--target-dir` may fail " +
  "with a missing .rmeta error - see README 'Known limitations'.";

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

export async function detectSharedTargetWarning(opts: {
  buildCacheEnabled: boolean;
  effectiveTargetCacheEnabled: boolean;
  buildCacheMode: string;
  targetDir: string;
}): Promise<void> {
  const logger = createLogger(process.env);
  const targetDir = (opts.targetDir ?? "").trim();
  if (!targetDir) {
    logger.log("shared-target-dir check skipped: no target dir resolved");
    return;
  }
  if (
    shouldEmitSharedTargetWarning({
      buildCacheEnabled: opts.buildCacheEnabled,
      buildCacheMode: opts.buildCacheMode,
      targetCacheEnabled: opts.effectiveTargetCacheEnabled,
      targetDir,
    })
  ) {
    core.warning(WARNING_MESSAGE);
    logger.log(
      `shared-target-dir warning emitted for target_dir=${targetDir} build_cache_mode=${opts.buildCacheMode}`,
    );
  } else {
    logger.log(
      `shared-target-dir check clean for target_dir=${targetDir} ` +
        `build_cache_mode=${opts.buildCacheMode} ` +
        `build_cache_enabled=${opts.buildCacheEnabled} ` +
        `target_cache_enabled=${opts.effectiveTargetCacheEnabled}`,
    );
  }
}
