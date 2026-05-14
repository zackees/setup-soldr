// setup-soldr post-job entry point. Owned by Agent 2.
//
// Runs in the post-job phase via action.yml's `post: dist/post.js`. This is
// the architectural fix for zackees/setup-soldr#70 — it lets us tar+zstd
// the build-cache (and optionally cargo-registry) directories BEFORE
// @actions/cache's post-save uploads them, so the wire format is zstd on
// every platform (including Windows-x64 where actions/cache@v5 still
// falls back to gzip).

import * as fs from "node:fs";
import * as core from "@actions/core";
import * as cache from "@actions/cache";
import { compressCache } from "./lib/cache-compress.js";
import { createLogger } from "./lib/log-utils.js";
import { StatsCollector } from "./lib/stats-collector.js";
import type { ResolveResult, StatsMode } from "./lib/types.js";

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface SaveOneResult {
  archiveBytes: number | null;
  inflatedBytes: number | null;
  fileCount: number | null;
  skipped: boolean;
}

async function saveOne(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
  key: string;
  matchedKey: string;
  label: string;
  debug: boolean;
  log: (msg: string) => void;
}): Promise<SaveOneResult> {
  const { cacheDir, codec, level, key, matchedKey, label, debug, log } = opts;
  const nullResult: SaveOneResult = { archiveBytes: null, inflatedBytes: null, fileCount: null, skipped: true };
  if (!dirExists(cacheDir)) {
    log(`${label}: cache dir ${cacheDir} does not exist, skipping save`);
    return nullResult;
  }
  if (matchedKey === key) {
    log(`${label}: exact cache hit on ${key}, skipping save`);
    return nullResult;
  }
  const { archivePath, archiveBytes, inflatedBytes, fileCount } = await compressCache({
    cacheDir,
    codec,
    level,
    debug,
    log,
  });
  const pathsToSave = archivePath ? [archivePath] : [cacheDir];
  try {
    const id = await cache.saveCache(pathsToSave, key);
    log(`${label}: saved cache id=${id} key=${key} via ${archivePath ? "tar.zst" : "default"}`);
  } catch (err) {
    log(`${label}: save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { archiveBytes, inflatedBytes, fileCount, skipped: false };
}

export async function run(): Promise<void> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);
  const state = core.getState("resolveResult");
  if (!state) {
    log("post: no resolve state available, exiting");
    return;
  }
  let result: ResolveResult;
  try {
    result = JSON.parse(state) as ResolveResult;
  } catch (err) {
    log(`post: failed to parse resolve state: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const buildCacheMatched = core.getState("buildCacheMatchedKey");
  const registryMatched = core.getState("cargoRegistryCacheMatchedKey");
  const statsMode = (core.getState("statsMode") || "summarize") as StatsMode;
  const runnerTemp = core.getState("runnerTemp") || "";
  const debugMode = result.debugMode ?? false;
  const debugLog = debugMode ? log : (): void => undefined;

  const postCollector = new StatsCollector();

  // Build cache
  const buildSaveStart = Date.now();
  const buildSaveResult = await saveOne({
    cacheDir: result.buildCache.path,
    codec: result.targetCacheCompress,
    level: result.targetCacheCompressLevel,
    key: result.buildCache.key,
    matchedKey: buildCacheMatched,
    label: "build-cache",
    debug: debugMode,
    log: debugLog,
  });
  if (!buildSaveResult.skipped) {
    postCollector.record({
      label: "build-cache",
      operation: "save",
      hit: false,
      key: result.buildCache.key,
      matchedKey: buildCacheMatched,
      restoreKeys: [],
      archiveBytes: buildSaveResult.archiveBytes,
      inflatedBytes: buildSaveResult.inflatedBytes,
      fileCount: buildSaveResult.fileCount,
      durationMs: Date.now() - buildSaveStart,
      timestamp: new Date().toISOString(),
    });
  }

  // Cargo registry cache (only when enabled)
  if (result.cargoRegistryCache.enabled) {
    const regSaveStart = Date.now();
    const regSaveResult = await saveOne({
      cacheDir: result.cargoRegistryCache.path,
      codec: result.targetCacheCompress,
      level: result.targetCacheCompressLevel,
      key: result.cargoRegistryCache.key,
      matchedKey: registryMatched,
      label: "cargo-registry-cache",
      debug: debugMode,
      log: debugLog,
    });
    if (!regSaveResult.skipped) {
      postCollector.record({
        label: "cargo-registry",
        operation: "save",
        hit: false,
        key: result.cargoRegistryCache.key,
        matchedKey: registryMatched,
        restoreKeys: [],
        archiveBytes: regSaveResult.archiveBytes,
        inflatedBytes: regSaveResult.inflatedBytes,
        fileCount: regSaveResult.fileCount,
        durationMs: Date.now() - regSaveStart,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Append save ops to session log when detailed stats are enabled
  if (statsMode === "detailed" && runnerTemp) {
    try {
      await postCollector.appendSavesToSessionLog(runnerTemp);
    } catch (err) {
      log(`post: stats log append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// See main.ts for the rationale behind the test-import escape hatch.
if (
  typeof process !== "undefined" &&
  !process.env["SETUP_SOLDR_TEST_IMPORT"]
) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    core.warning(`setup-soldr post-job step failed: ${message}`);
  });
}
