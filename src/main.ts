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
import { normalizeSourceMtime } from "./lib/normalize-source-mtime.js";
import { detectSharedTargetWarning } from "./lib/detect-shared-target-warning.js";
import { ensureShims } from "./lib/ensure-shims.js";
import { detectCompressMagic, decompressCache } from "./lib/cache-compress.js";
import { StatsCollector } from "./lib/stats-collector.js";
import type { ActionContext } from "./lib/types.js";

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

  const dryRun = TRUTHY.has((process.env["SETUP_SOLDR_DRY_RUN"] ?? "").trim().toLowerCase());
  if (dryRun) {
    logger.log("DRY RUN: setup-soldr dry run — skipping cache, install, and verify");
    await finishPhase("action");
    return;
  }

  // Persist resolve state for the post-job step.
  core.saveState("resolveResult", JSON.stringify(result));
  core.saveState("buildCacheMode", result.buildCache.mode);

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
    const restore = await restoreCacheSafe(
      [archivePath, buildCachePath],
      result.buildCache.key,
      restoreKeys,
      logger,
    );
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
  await markPhase("toolchain");
  await ensureRustToolchain({ resolveResult: result, setupCacheExactHit });
  await finishPhase("toolchain");

  // ---- install soldr ----
  await markPhase("install");
  await ensureSoldr({ resolveResult: result, githubToken: ctx.githubToken });
  await finishPhase("install");

  // Export SOLDR_BINARY so shims can exec it directly
  core.exportVariable("SOLDR_BINARY", result.soldrPath);

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
  const verify = await verifySoldr({
    soldrPath: result.soldrPath,
    buildCacheMode: result.buildCache.mode,
    requireRustPlan: result.targetCache.enabled,
  });
  core.setOutput("soldr-version", verify.soldrVersion);
  core.setOutput("soldr_version", verify.soldrVersion);
  await finishPhase("verify");

  // ---- cargo-registry restore (if requested) ----
  if (result.cargoRegistryCache.enabled) {
    const registryArchive = `${result.cargoRegistryCache.path}.tar.zst`;
    const t0 = Date.now();
    const restore = await restoreCacheSafe(
      [registryArchive, result.cargoRegistryCache.path],
      result.cargoRegistryCache.key,
      [result.cargoRegistryCache.restorePrefix],
      logger,
    );
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
  core.saveState("runnerTemp", ctx.runnerTemp);

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
