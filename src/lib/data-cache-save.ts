// Shared data-cache publication. This module never installs or invokes Soldr,
// restored toolchains, source scripts, or compiler outputs. Callers must enforce
// job-success, dependency-yank and new-compilation gates before publication.
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { compressCache, type CachePayloadProfile } from "./cache-compress.js";
import { allowCacheSave, gatedSaveCache } from "./save-policy.js";
import { FAILED_JOB_SKIP_STATUS } from "./failed-job-save.js";
import type { CachePayloadCensus } from "./types.js";

function dirExists(directory: string): boolean {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

export type SaveStatus =
  | "disabled"
  | "not-managed-in-post"
  | "exact-hit-skip"
  | "missing-dir-skip"
  | "oversize-skip"
  | "race-skip"
  | "tiny-delta-skip"
  | "policy-skip"
  | typeof FAILED_JOB_SKIP_STATUS
  | "saved"
  | "failed";

interface CacheSavePhaseTimings {
  compressMs?: number;
  uploadMs?: number;
}

export interface CacheSaveResult {
  status: SaveStatus;
  cache_dir?: string;
  archive_path?: string;
  saved_paths?: string[];
  cache_id?: number;
  error?: string;
  archiveBytes?: number | null;
  inflatedBytes?: number | null;
  fileCount?: number | null;
  payload?: CachePayloadCensus | null;
  /** Per-phase save timing (issue #214). */
  phaseTimings?: CacheSavePhaseTimings;
  /** Reason text for a gated skip (e.g. tiny-delta). */
  skip_reason?: string;
}


export interface CachePayloadPolicy {
  warnBytes: number | null;
  maxBytes: number | null;
  oversizeAction: "skip" | "fail";
  topN: number;
}


export function applyCachePayloadOversizeAction(
  action: "skip" | "fail",
  message: string,
  setFailed: (message: string) => void = core.setFailed,
): "oversize-skip" | "failed" {
  if (action === "fail") {
    setFailed(message);
    return "failed";
  }
  return "oversize-skip";
}


export type CacheSaveResultWithStats = CacheSaveResult & {
  archiveBytes: number | null;
  inflatedBytes: number | null;
  fileCount: number | null;
  payload: CachePayloadCensus | null;
};

export async function saveDataCache(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
  key: string;
  matchedKey: string;
  label: string;
  debug: boolean;
  log: (msg: string) => void;
  /**
   * Optional sibling basenames bundled into the same archive as `cacheDir`.
   * Used by the cargo-registry layer to ship `.global-cache` and `git/` next
   * to `registry/` without a new cache layer — setup-soldr#102.
   */
  extraBasenames?: string[];
  payloadProfile?: CachePayloadProfile;
  payloadPolicy: CachePayloadPolicy;
  /** Stable SDK path, resolving to the exact compressed archive in private cwd. */
  archiveCachePath?: string;
}): Promise<CacheSaveResultWithStats> {
  const { cacheDir, codec, level, key, matchedKey, label, debug, log, extraBasenames, payloadProfile, payloadPolicy } = opts;
  const withStats = (r: CacheSaveResult): CacheSaveResultWithStats =>
    Object.assign(r, {
      archiveBytes: null,
      inflatedBytes: null,
      fileCount: null,
      payload: null,
    });
  // #527: shared save policy (save-cache input / pull_request event).
  if (!allowCacheSave(label, (m) => core.info(m))) {
    return withStats({ status: "policy-skip", cache_dir: cacheDir });
  }
  if (!dirExists(cacheDir)) {
    log(`${label}: cache dir ${cacheDir} does not exist, skipping save`);
    return withStats({ status: "missing-dir-skip", cache_dir: cacheDir });
  }
  if (matchedKey === key) {
    log(`${label}: exact cache hit on ${key}, skipping save`);
    return withStats({ status: "exact-hit-skip", cache_dir: cacheDir });
  }
  let archiveBytes: number | null = null;
  let archivePath: string | null = null;
  let inflatedBytes: number | null = null;
  let fileCount: number | null = null;
  let payload: CachePayloadCensus | null = null;
  // Per-phase save timing (#214): separate the archive+compress phase from the
  // cache reservation+upload phase so a slow Windows post step is diagnosable.
  let compressMs = 0;
  let uploadMs = 0;
  const compressStart = Date.now();
  let skippedReason: "payload-too-large" | undefined;
  try {
    if (archivePath === null) {
      const result = await compressCache({
        cacheDir,
        codec,
        level,
        debug,
        log,
        extraBasenames,
        payloadWarnBytes: payloadPolicy.warnBytes,
        payloadMaxBytes: payloadPolicy.maxBytes,
        payloadOversizeAction: payloadPolicy.oversizeAction,
        payloadTopN: payloadPolicy.topN,
        payloadProfile,
        label,
        cacheKey: key,
      });
      archivePath = result.archivePath;
      archiveBytes = result.archiveBytes || null;
      inflatedBytes = result.inflatedBytes;
      fileCount = result.fileCount;
      payload = result.payload;
      skippedReason = result.skippedReason;
      compressMs = Date.now() - compressStart;
    }
    if (skippedReason === "payload-too-large") {
      log(`${label}: payload exceeded cache-payload-max-bytes, skipping save`);
      return {
        status: "oversize-skip",
        cache_dir: cacheDir,
        archiveBytes,
        inflatedBytes,
        fileCount,
        payload,
        phaseTimings: { compressMs },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      payloadPolicy.oversizeAction === "fail" &&
      message.includes("exceeding cache-payload-max-bytes")
    ) {
      applyCachePayloadOversizeAction("fail", message);
    }
    log(`${label}: compression failed: ${message}`);
    return withStats({ status: "failed", cache_dir: cacheDir, error: message });
  }
  const pathsToSave = archivePath ? [archivePath] : [cacheDir];
  let sdkPaths = pathsToSave;
  try {
    if (opts.archiveCachePath !== undefined) {
      if (!archivePath || path.resolve(opts.archiveCachePath) !== path.resolve(archivePath)) {
        throw new Error("SDK archive path must identify the compressed payload");
      }
      sdkPaths = [opts.archiveCachePath];
    }
    const uploadStart = Date.now();
    const id = await gatedSaveCache(label, sdkPaths, key, (m) => core.info(m));
    uploadMs = Date.now() - uploadStart;
    log(
      `${label}: saved cache id=${id} key=${key} via ${archivePath ? "tar.zst" : "default"} ` +
        `(compress=${compressMs}ms upload=${uploadMs}ms)`,
    );
    return {
      status: "saved",
      cache_dir: cacheDir,
      archive_path: archivePath ?? undefined,
      saved_paths: sdkPaths,
      cache_id: id,
      archiveBytes,
      inflatedBytes,
      fileCount,
      payload,
      phaseTimings: { compressMs, uploadMs },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${label}: save failed: ${message}`);
    return {
      status: "failed",
      cache_dir: cacheDir,
      archive_path: archivePath ?? undefined,
      saved_paths: sdkPaths,
      error: message,
      archiveBytes,
      inflatedBytes,
      fileCount,
      payload,
      phaseTimings: { compressMs, uploadMs },
    };
  }
}

