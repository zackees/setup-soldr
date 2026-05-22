// setup-soldr entry point. Owned by Agent 2.
//
// Replaces the composite action's main-phase steps with a single JS
// orchestrator. Calls the helpers in src/lib/* in the same order the
// composite's steps fire.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as cache from "@actions/cache";
import { createLogger } from "./lib/log-utils.js";
import { readRawInputs, resolveSetup, applyResolveResult } from "./lib/resolve-setup.js";
import { markPhase, finishPhase } from "./lib/phase-timing.js";
import { ensureRustToolchain } from "./lib/ensure-rust-toolchain.js";
import { ensureSoldr } from "./lib/ensure-soldr.js";
import { verifySoldr } from "./lib/verify-soldr.js";
import { installPassthrough } from "./lib/install-passthrough.js";
import { normalizeSourceMtime } from "./lib/normalize-source-mtime.js";
import { detectSharedTargetWarning } from "./lib/detect-shared-target-warning.js";
import { ensureShims } from "./lib/ensure-shims.js";
import { detectCompressMagic, decompressCache } from "./lib/cache-compress.js";
import { StatsCollector } from "./lib/stats-collector.js";
import {
  walkSnapshot,
  diffSnapshots,
  diffStats,
  serializeManifest,
} from "./lib/toolchain-snapshot.js";
import {
  buildSoloCacheKeys,
  detectLibc,
  hashStringArray,
  restoreSoloCache,
  verifyRestoredToolchain,
  type RootMap as SoloRootMap,
} from "./lib/solo-toolchain-cache.js";
import { dumpDiagnostics, loggingEnabled } from "./lib/diagnostics.js";
import {
  replaySourceMtimes,
  readSnapshotFile,
  SNAPSHOT_FILENAME,
} from "./lib/source-mtime-snapshot.js";
import type { ActionContext, ResolveResult } from "./lib/types.js";

/**
 * Map (hit, matchedKey) → workflow-visible restore-status string.
 * Mirrors post.ts's `RestoreStatus` so both phases emit the same vocabulary
 * for the `<layer>-cache-restore-status` outputs declared in action.yml.
 */
function deriveRestoreStatus(hit: boolean, matchedKey: string): "exact-hit" | "restore-key-hit" | "miss" {
  if (hit) return "exact-hit";
  if (matchedKey.trim()) return "restore-key-hit";
  return "miss";
}

function writeCacheKeysManifest(
  result: ResolveResult,
  runnerTemp: string,
  log: (msg: string) => void,
): void {
  if (!runnerTemp) return;
  const keys = [
    result.setupCache.key,
    result.buildCache.key,
    result.targetCache.key,
    result.cargoRegistryCache.key,
  ].filter((k) => Boolean(k));
  if (keys.length === 0) return;
  const outPath = path.join(runnerTemp, "setup-soldr-cache-keys.txt");
  try {
    fs.writeFileSync(outPath, keys.join("\n") + "\n", "utf8");
    log(`cache-keys manifest written to ${outPath} (${keys.length} keys)`);
  } catch (err) {
    log(`cache-keys manifest write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function isTruthy(value: string | undefined): boolean {
  return TRUTHY.has(((value ?? "").trim().toLowerCase()));
}
function isFalsy(value: string | undefined): boolean {
  return FALSY.has(((value ?? "").trim().toLowerCase()));
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirHasContent(p: string): boolean {
  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function buildActionContext(): ActionContext {
  const env = process.env;
  const logger = createLogger(env);
  const workspace = env["ACTION_WORKSPACE"]?.trim() || env["GITHUB_WORKSPACE"]?.trim() || process.cwd();
  const runnerTemp = env["RUNNER_TEMP"]?.trim() || path.join(os.tmpdir(), "setup-soldr-runner");
  const runnerOs = env["ACTION_OS"]?.trim() || env["RUNNER_OS"]?.trim() || process.platform;
  const runnerArch = env["ACTION_ARCH"]?.trim() || env["RUNNER_ARCH"]?.trim() || process.arch;
  const githubSha = env["GITHUB_SHA"]?.trim() || "";
  const githubToken = env["GITHUB_TOKEN"]?.trim() || env["INPUT_TOKEN"]?.trim() || "";
  const parentSha = env["ACTION_PARENT_SHA"]?.trim() || "";
  return {
    env: { ...env },
    workspace,
    runnerTemp,
    runnerOs,
    runnerArch,
    githubSha,
    githubToken,
    parentSha,
    logger,
  };
}

async function restoreCacheSafe(
  paths: string[],
  key: string,
  restoreKeys: string[],
  logger: { log: (msg: string) => void },
): Promise<{ hit: boolean; matchedKey: string }> {
  if (paths.length === 0 || !key) {
    return { hit: false, matchedKey: "" };
  }
  try {
    const matched = await cache.restoreCache(paths, key, restoreKeys);
    return { hit: matched === key, matchedKey: matched ?? "" };
  } catch (err) {
    logger.log(`cache restore failed for key ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: "" };
  }
}

export async function run(): Promise<void> {
  const ctx = buildActionContext();
  const logger = ctx.logger;

  await markPhase("action");

  // ---- resolve ----
  await markPhase("resolve");
  const inputs = readRawInputs(process.env);
  const result = await resolveSetup(ctx, inputs);
  await applyResolveResult(result);
  await finishPhase("resolve");

  // Always emit the cache-keys manifest right after resolve so workflow
  // steps that run between main and post (e.g. actions/upload-artifact)
  // can read it. The four keys are fully determined by resolveSetup and
  // never change later in the run.
  writeCacheKeysManifest(result, ctx.runnerTemp, (msg) => logger.log(msg));

  const logging = loggingEnabled(inputs.logging);
  if (logging) {
    dumpDiagnostics({
      phase: "main",
      env: process.env,
      rawInputs: inputs,
      result,
      logger,
      stepSummaryPath: process.env["GITHUB_STEP_SUMMARY"]?.trim() || undefined,
    });
  }

  const dryRun = TRUTHY.has((process.env["SETUP_SOLDR_DRY_RUN"] ?? "").trim().toLowerCase());
  if (dryRun) {
    logger.log("DRY RUN: setup-soldr dry run — skipping cache, install, and verify");
    await finishPhase("action");
    return;
  }

  // Persist resolve state for the post-job step.
  core.saveState("resolveResult", JSON.stringify(result));
  core.saveState("buildCacheMode", result.buildCache.mode);
  core.saveState("logging", logging ? "true" : "false");
  core.saveState("preserveSourceMtimes", isTruthy(inputs.preserveSourceMtimes) ? "true" : "false");

  const statsMode = result.stats;
  const debugMode = result.debugMode;
  const debugLog = debugMode ? (msg: string): void => logger.log(msg) : (): void => undefined;
  const statsCollector = new StatsCollector();

  // ---- source-mtime-normalize ----
  if (isTruthy(inputs.sourceMtimeNormalize)) {
    await normalizeSourceMtime({ workspace: ctx.workspace, enabled: true });
  }

  const cacheEnabled = !isFalsy(inputs.cache.trim() || "true");
  const buildCacheEnabled = !isFalsy(inputs.buildCache.trim() || "true");
  core.saveState("setupCacheEnabled", cacheEnabled && result.setupCache.paths.length > 0 ? "true" : "false");
  core.saveState("setupCacheExactHit", "false");
  core.saveState("setupCacheMatchedKey", "");
  core.saveState("targetCacheEnabled", result.targetCache.enabled ? "true" : "false");
  core.saveState("targetCacheExactHit", "false");
  core.saveState("targetCacheMatchedKey", "");
  core.saveState("buildCacheEnabled", buildCacheEnabled ? "true" : "false");
  core.saveState("buildCacheExactHit", "false");
  core.saveState("buildCacheMatchedKey", "");
  core.saveState("cargoRegistryCacheEnabled", result.cargoRegistryCache.enabled ? "true" : "false");
  core.saveState("cargoRegistryCacheExactHit", "false");
  core.saveState("cargoRegistryCacheMatchedKey", "");

  // ---- setup-cache ----
  await markPhase("setup-cache");
  let setupCacheExactHit = false;
  if (cacheEnabled && result.setupCache.paths.length > 0) {
    const t0 = Date.now();
    const restore = await restoreCacheSafe(
      result.setupCache.paths,
      result.setupCache.key,
      [result.setupCache.restorePrefix],
      logger,
    );
    setupCacheExactHit = restore.hit;
    // action.yml-declared canonical names (see #125 — these are what
    // downstream workflows reference). Legacy underscored aliases retained
    // for backwards compat.
    core.setOutput("cache-hit", restore.hit ? "true" : "false");
    core.setOutput("cache-restore-status", deriveRestoreStatus(restore.hit, restore.matchedKey));
    core.setOutput("setup_cache_hit", restore.hit ? "true" : "false");
    core.setOutput("setup_cache_matched_key", restore.matchedKey);
    core.saveState("setupCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("setupCacheMatchedKey", restore.matchedKey);
    // Expose for ensure_rust_toolchain to read via env (the python port did this).
    process.env["SETUP_SOLDR_SETUP_CACHE_EXACT_HIT"] = restore.hit ? "true" : "false";
    statsCollector.record({
      label: "setup-cache", operation: "restore", hit: restore.hit,
      key: result.setupCache.key, matchedKey: restore.matchedKey,
      restoreKeys: [result.setupCache.restorePrefix],
      archiveBytes: null, inflatedBytes: null, fileCount: null,
      durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
    });
    if (debugMode) debugLog(`[debug] setup-cache: hit=${restore.hit} matched=${restore.matchedKey || "(none)"}`);
  }
  await finishPhase("setup-cache");

  // ---- target-cache ----
  await markPhase("target-cache");
  if (result.targetCache.enabled) {
    const targetPaths = result.targetCache.paths
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (targetPaths.length > 0) {
      const restoreKeys: string[] = [];
      if (result.targetCache.restoreKeyParent) restoreKeys.push(result.targetCache.restoreKeyParent);
      if (result.targetCache.restoreKeyLock) restoreKeys.push(result.targetCache.restoreKeyLock);
      if (result.targetCache.restoreKeyLockfile) restoreKeys.push(result.targetCache.restoreKeyLockfile);
      const t0 = Date.now();
      const restore = await restoreCacheSafe(targetPaths, result.targetCache.key, restoreKeys, logger);
      core.setOutput("target-cache-hit", restore.hit ? "true" : "false");
      core.setOutput("target-cache-restore-status", deriveRestoreStatus(restore.hit, restore.matchedKey));
      core.setOutput("target_cache_hit", restore.hit ? "true" : "false");
      core.setOutput("target_cache_matched_key", restore.matchedKey);
      core.saveState("targetCacheExactHit", restore.hit ? "true" : "false");
      core.saveState("targetCacheMatchedKey", restore.matchedKey);
      statsCollector.record({
        label: "target-cache", operation: "restore", hit: restore.hit,
        key: result.targetCache.key, matchedKey: restore.matchedKey, restoreKeys,
        archiveBytes: null, inflatedBytes: null, fileCount: null,
        durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
      });
      if (debugMode) debugLog(`[debug] target-cache: hit=${restore.hit} matched=${restore.matchedKey || "(none)"}`);
    }
  }
  await finishPhase("target-cache");

  // ---- build-cache ----
  await markPhase("build-cache");
  if (buildCacheEnabled) {
    const buildCachePath = result.buildCache.path;
    const archivePath = `${buildCachePath}.tar.zst`;
    const restoreKeys: string[] = [];
    if (result.buildCache.restoreKeyParent) restoreKeys.push(result.buildCache.restoreKeyParent);
    if (result.buildCache.restoreKeyToolchain) restoreKeys.push(result.buildCache.restoreKeyToolchain);
    if (result.buildCache.restoreKeyOsArch) restoreKeys.push(result.buildCache.restoreKeyOsArch);
    const t0 = Date.now();
    // @actions/cache hashes the `paths` array into a "version" key — save and
    // restore MUST pass the same array or the lookup misses even when the
    // entry exists. post.ts saves `[archivePath]` (just the .tar.zst), so
    // restore must use the same single-path array. The decompression below
    // unpacks archivePath → buildCachePath afterwards.
    const restore = await restoreCacheSafe(
      [archivePath],
      result.buildCache.key,
      restoreKeys,
      logger,
    );
    core.setOutput("build-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("build-cache-restore-status", deriveRestoreStatus(restore.hit, restore.matchedKey));
    core.setOutput("build_cache_hit", restore.hit ? "true" : "false");
    core.setOutput("build_cache_matched_key", restore.matchedKey);
    core.saveState("buildCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("buildCacheMatchedKey", restore.matchedKey);
    let buildArchiveBytes: number | null = null;
    let buildInflatedBytes: number | null = null;
    let buildFileCount: number | null = null;
    if (fileExists(archivePath)) {
      const magic = await detectCompressMagic(archivePath);
      if (magic === "zstd" || magic === "gzip") {
        try {
          const dr = await decompressCache({ archivePath, targetDir: buildCachePath, debug: debugMode, log: debugLog });
          buildArchiveBytes = dr.archiveBytes;
          buildInflatedBytes = dr.inflatedBytes;
          buildFileCount = dr.fileCount;
        } catch (err) {
          logger.log(
            `build-cache decompress failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    // Source-mtime replay (preserve-source-mtimes opt-in). post.ts dropped
    // a `setup-soldr-source-mtimes.json` sidecar inside the build-cache
    // dir on the cold side; if it's present after decompress, walk it and
    // set each matching source file's mtime to what cold saw. The replay
    // is gated by (size, content-hash) match so we never overwrite a
    // genuinely modified file's mtime — that would underbuild.
    if (isTruthy(inputs.preserveSourceMtimes) && restore.hit) {
      const snapshotPath = path.join(buildCachePath, SNAPSHOT_FILENAME);
      const snapshot = readSnapshotFile(snapshotPath);
      if (snapshot) {
        const rt0 = Date.now();
        try {
          // Match the project-root selection that post.ts uses when
          // writing the snapshot — the parent of the resolved target-dir,
          // not the (outer) GITHUB_WORKSPACE.
          const projectRoot = path.dirname(result.targetCache.targetPath);
          const rr = await replaySourceMtimes({
            workspace: projectRoot,
            snapshot,
            log: (msg) => logger.log(msg),
          });
          logger.log(
            `source-mtime-replay: applied=${rr.applied} skipped_missing=${rr.skipped_missing} ` +
              `skipped_modified=${rr.skipped_modified} skipped_size_mismatch=${rr.skipped_size_mismatch} ` +
              `total=${rr.total} elapsed_ms=${Date.now() - rt0}`,
          );
        } catch (err) {
          logger.log(
            `source-mtime-replay: failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.log(`source-mtime-replay: snapshot file not found at ${snapshotPath}, skipping`);
      }
    }
    statsCollector.record({
      label: "build-cache", operation: "restore", hit: restore.hit,
      key: result.buildCache.key, matchedKey: restore.matchedKey, restoreKeys,
      archiveBytes: buildArchiveBytes, inflatedBytes: buildInflatedBytes, fileCount: buildFileCount,
      durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
    });
  }
  await finishPhase("build-cache");

  // ---- target-tree-cache (full mode) ----
  await markPhase("target-tree");
  // The bundle path is included in target-cache restore paths above when full
  // mode is requested, so there's no separate restore here. We keep the phase
  // marker for parity with the composite step ordering.
  await finishPhase("target-tree");

  // ---- toolchain ----
  // Snapshot $RUSTUP_HOME/toolchains/ + $CARGO_HOME/bin/ around the
  // toolchain install so we can see which inodes setup-soldr added on
  // top of the runner image. When solo-toolchain-cache is opted in, a
  // third snapshot is taken *before* the cache restore so the saved
  // tarball captures the full above-runner state — not just the
  // post-restore delta. See CLAUDE.md "Detect-then-cache" + "Cache-
  // lifetime axis".
  await markPhase("toolchain");
  const snapshotRoots = [
    path.join(result.rustupHome, "toolchains"),
    path.join(result.cargoHome, "bin"),
  ];
  const soloRootMap: SoloRootMap = {
    "rustup-toolchains": snapshotRoots[0] as string,
    "cargo-bin": snapshotRoots[1] as string,
  };
  const soloEnabled = isTruthy(inputs.soloToolchainCache);
  const soloLevel = (inputs.soloToolchainCacheLevel.trim() || "19");
  let soloKeys: ReturnType<typeof buildSoloCacheKeys> | null = null;
  let soloMatchedKey = "";
  let soloExactHit = false;
  // Pre-restore snapshot — only needed when solo cache is enabled, so
  // we can compute the full save-diff (post-install vs runner-image,
  // not vs post-restore baseline).
  const preRestoreSnapshot = soloEnabled ? await walkSnapshot(snapshotRoots) : null;
  if (soloEnabled) {
    soloKeys = buildSoloCacheKeys({
      runnerOs: ctx.runnerOs.toLowerCase() || process.platform,
      runnerArch: ctx.runnerArch.toLowerCase() || process.arch,
      libc: detectLibc(),
      rustcRelease: result.toolchain.cacheChannel.trim() || result.toolchain.channel.trim(),
      componentsHash: hashStringArray(result.toolchain.components),
      targetsHash: hashStringArray(result.toolchain.targets),
      soldrVersion: result.soldrVersionResolved.trim() || result.soldrVersionRequested.trim() || "unset",
    });
    logger.log(`solo-toolchain-cache: key=${soloKeys.exact}`);
    const restoreT0 = Date.now();
    const stagingDir = path.join(ctx.runnerTemp, "setup-soldr-solo-cache");
    const restored = await restoreSoloCache({
      keys: soloKeys,
      rootMap: soloRootMap,
      stagingDir,
      log: (msg) => logger.log(msg),
    });
    soloMatchedKey = restored.matchedKey;
    let verifiedMatch = true;
    if (restored.verified && restored.matchedKey) {
      const expected = result.toolchain.cacheChannel.trim();
      // The rustup home is set up so `rustc` will resolve through the
      // restored toolchain dir. Use `rustc` from PATH (rustup shim) or
      // the cargo bin one.
      const rustcCmd = process.platform === "win32" ? "rustc.exe" : "rustc";
      const verify = await verifyRestoredToolchain({
        expectedRelease: expected,
        rustcCommand: rustcCmd,
        log: (msg) => logger.log(msg),
      });
      verifiedMatch = verify.match;
    }
    soloExactHit = restored.hit && verifiedMatch;
    core.saveState("soloToolchainEnabled", "true");
    core.saveState("soloToolchainExactKey", soloKeys.exact);
    core.saveState("soloToolchainMatchedKey", soloMatchedKey);
    core.saveState("soloToolchainExactHit", soloExactHit ? "true" : "false");
    core.saveState("soloToolchainLevel", soloLevel);
    statsCollector.record({
      label: "solo-toolchain-cache",
      operation: "restore",
      hit: soloExactHit,
      key: soloKeys.exact,
      matchedKey: soloMatchedKey,
      restoreKeys: soloKeys.fallbacks,
      archiveBytes: restored.restoredBytes || null,
      inflatedBytes: null,
      fileCount: null,
      durationMs: Date.now() - restoreT0,
      timestamp: new Date().toISOString(),
    });
  } else {
    core.saveState("soloToolchainEnabled", "false");
  }
  const baselineSnapshot = await walkSnapshot(snapshotRoots);
  await ensureRustToolchain({ resolveResult: result, setupCacheExactHit });
  const postInstallSnapshot = await walkSnapshot(snapshotRoots);
  const toolchainDiff = diffSnapshots(baselineSnapshot, postInstallSnapshot);
  const toolchainDiffStats = diffStats(toolchainDiff);
  // When solo cache is enabled, also compute the save-diff (post-install
  // vs pre-restore) so post.ts has the full above-runner manifest to tar.
  if (soloEnabled && preRestoreSnapshot && ctx.runnerTemp) {
    const saveDiff = diffSnapshots(preRestoreSnapshot, postInstallSnapshot);
    const saveDiffStats = diffStats(saveDiff);
    const saveDiffPath = path.join(ctx.runnerTemp, "setup-soldr-solo-save-diff.json");
    try {
      await fs.promises.writeFile(
        saveDiffPath,
        serializeManifest(saveDiff, saveDiffStats),
        "utf8",
      );
      core.saveState("soloToolchainSaveDiffPath", saveDiffPath);
      core.saveState("soloToolchainIncrementalEmpty", toolchainDiff.added.length === 0 ? "true" : "false");
      logger.log(
        `solo-toolchain-cache: save-diff added=${saveDiffStats.addedFiles} files (${
          saveDiffStats.addedBytes < 1024 * 1024
            ? `${(saveDiffStats.addedBytes / 1024).toFixed(1)}KB`
            : `${(saveDiffStats.addedBytes / 1024 / 1024).toFixed(1)}MB`
        }) ` +
          `incremental-empty=${toolchainDiff.added.length === 0}`,
      );
    } catch (err) {
      logger.log(
        `solo-toolchain-cache: save-diff write failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const fmtMB = (bytes: number): string =>
    bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  logger.log(
    `toolchain-snapshot: added=${toolchainDiffStats.addedFiles} files (${fmtMB(toolchainDiffStats.addedBytes)}) ` +
      `changed=${toolchainDiffStats.changedFiles} removed=${toolchainDiffStats.removedFiles}`,
  );
  if (ctx.runnerTemp) {
    const manifestPath = path.join(ctx.runnerTemp, "setup-soldr-toolchain-diff.json");
    try {
      await fs.promises.writeFile(
        manifestPath,
        serializeManifest(toolchainDiff, toolchainDiffStats),
        "utf8",
      );
      logger.log(`toolchain-snapshot: manifest at ${manifestPath}`);
    } catch (err) {
      logger.log(
        `toolchain-snapshot: manifest write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await finishPhase("toolchain");

  // ---- install soldr ----
  await markPhase("install");
  if (result.enabled) {
    await ensureSoldr({ resolveResult: result, githubToken: ctx.githubToken });
  } else {
    installPassthrough({
      soldrPath: result.soldrPath,
      isWindows: process.platform === "win32",
      log: (msg) => logger.log(msg),
    });
    logger.warning(
      "setup-soldr: enable=false — installed a passthrough stub at " +
        `${result.soldrPath}. \`soldr <tool> <args>\` will run \`<tool> <args>\` ` +
        "verbatim, and soldr-aware caching/observability is disabled.",
    );
  }
  await finishPhase("install");

  // Export SOLDR_BINARY so shims can exec it directly
  core.exportVariable("SOLDR_BINARY", result.soldrPath);
  core.saveState("setupSoldrPassthrough", result.enabled ? "false" : "true");

  // ---- shims ----
  if (result.shimsEnabled) {
    await ensureShims({
      shimsDir: result.shimsDir,
      soldrPath: result.soldrPath,
      isWindows: process.platform === "win32",
      log: (msg) => logger.log(msg),
    });
  }

  // ---- verify ----
  await markPhase("verify");
  if (result.enabled) {
    const verify = await verifySoldr({
      soldrPath: result.soldrPath,
      buildCacheMode: result.buildCache.mode,
      requireRustPlan: result.targetCache.enabled,
    });
    core.setOutput("soldr-version", verify.soldrVersion);
    core.setOutput("soldr_version", verify.soldrVersion);
  } else {
    core.setOutput("soldr-version", "passthrough");
    core.setOutput("soldr_version", "passthrough");
  }
  await finishPhase("verify");

  // ---- cargo-registry restore (if requested) ----
  if (result.cargoRegistryCache.enabled) {
    const registryArchive = `${result.cargoRegistryCache.path}.tar.zst`;
    const t0 = Date.now();
    // Match the single-path save (post.ts:`pathsToSave = [archivePath]`) so
    // the @actions/cache version hashes agree and the restore can find the
    // entry. See the build-cache restore comment above for details.
    const restore = await restoreCacheSafe(
      [registryArchive],
      result.cargoRegistryCache.key,
      [result.cargoRegistryCache.restorePrefix],
      logger,
    );
    core.setOutput("cargo-registry-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("cargo_registry_cache_hit", restore.hit ? "true" : "false");
    core.saveState("cargoRegistryCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("cargoRegistryCacheMatchedKey", restore.matchedKey);
    let regArchiveBytes: number | null = null;
    let regInflatedBytes: number | null = null;
    let regFileCount: number | null = null;
    if (fileExists(registryArchive)) {
      const magic = await detectCompressMagic(registryArchive);
      if (magic === "zstd" || magic === "gzip") {
        try {
          const dr = await decompressCache({
            archivePath: registryArchive,
            targetDir: result.cargoRegistryCache.path,
            debug: debugMode, log: debugLog,
          });
          regArchiveBytes = dr.archiveBytes;
          regInflatedBytes = dr.inflatedBytes;
          regFileCount = dr.fileCount;
        } catch (err) {
          logger.log(
            `cargo-registry decompress failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    statsCollector.record({
      label: "cargo-registry", operation: "restore", hit: restore.hit,
      key: result.cargoRegistryCache.key, matchedKey: restore.matchedKey,
      restoreKeys: [result.cargoRegistryCache.restorePrefix],
      archiveBytes: regArchiveBytes, inflatedBytes: regInflatedBytes, fileCount: regFileCount,
      durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
    });
  }

  // ---- shared-target warning ----
  await detectSharedTargetWarning({
    buildCacheEnabled,
    effectiveTargetCacheEnabled: result.targetCache.enabled,
    buildCacheMode: result.buildCache.mode,
    targetDir: result.targetCache.targetPath,
  });

  // ---- stats report ----
  statsCollector.report(statsMode, (msg) => logger.log(msg));
  if (statsMode === "detailed") {
    try {
      await statsCollector.writeFiles(ctx.runnerTemp);
      statsCollector.setGithubOutputs();
    } catch (err) {
      logger.log(`stats: failed to write files: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  core.saveState("statsCollector", statsCollector.serialize());
  core.saveState("statsMode", statsMode);
  core.saveState("compileCacheStats", result.compileCacheStats);
  core.saveState("runnerTemp", ctx.runnerTemp);

  if (logging) {
    dumpDiagnostics({
      phase: "main",
      env: process.env,
      rawInputs: inputs,
      result,
      cacheOutcomes: statsCollector.snapshot(),
      logger,
    });
  }

  await finishPhase("action");

  // dirHasContent is exported for tests; suppress unused warning here.
  void dirHasContent;
}

// Auto-invoke only when this module is run as the main entry point. This lets
// tests import `run` (and helpers) without triggering the side-effectful
// orchestration. The dist/main.js produced by ncc is invoked directly by the
// Actions runtime so the check trips and the action executes normally.
if (
  typeof process !== "undefined" &&
  process.env["SETUP_SOLDR_SKIP_AUTOSTART"] !== "1" &&
  // import.meta.url is the file URL of this module; argv[1] is the runner
  // entrypoint. ncc bundles into dist/main.js so the bundled path won't equal
  // the dev path — we rely on the env-var opt-out for tests instead.
  !process.env["SETUP_SOLDR_TEST_IMPORT"]
) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    core.setFailed(`setup-soldr failed: ${message}`);
  });
}
