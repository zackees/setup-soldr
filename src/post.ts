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
import type { ResolveResult } from "./lib/types.js";

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function saveOne(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
  key: string;
  matchedKey: string;
  label: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { cacheDir, codec, level, key, matchedKey, label, log } = opts;
  if (!dirExists(cacheDir)) {
    log(`${label}: cache dir ${cacheDir} does not exist, skipping save`);
    return;
  }
  if (matchedKey === key) {
    log(`${label}: exact cache hit on ${key}, skipping save`);
    return;
  }
  const archive = await compressCache({ cacheDir, codec, level });
  const pathsToSave = archive ? [archive] : [cacheDir];
  try {
    const id = await cache.saveCache(pathsToSave, key);
    log(`${label}: saved cache id=${id} key=${key} via ${archive ? "tar.zst" : "default"}`);
  } catch (err) {
    log(`${label}: save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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

  // Build cache
  await saveOne({
    cacheDir: result.buildCache.path,
    codec: result.targetCacheCompress,
    level: result.targetCacheCompressLevel,
    key: result.buildCache.key,
    matchedKey: buildCacheMatched,
    label: "build-cache",
    log,
  });

  // Cargo registry cache (only when enabled)
  if (result.cargoRegistryCache.enabled) {
    await saveOne({
      cacheDir: result.cargoRegistryCache.path,
      codec: result.targetCacheCompress,
      level: result.targetCacheCompressLevel,
      key: result.cargoRegistryCache.key,
      matchedKey: registryMatched,
      label: "cargo-registry-cache",
      log,
    });
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
