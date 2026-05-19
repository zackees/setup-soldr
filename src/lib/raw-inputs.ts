// Pure mapping from process.env → RawInputs. Split out of
// resolve-setup.ts so the orchestrator stays focused on cache-key
// derivation and side-effecting work. Each entry corresponds to one
// row in action.yml's `inputs:` block.

import type { RawInputs } from "./types.js";

export function readRawInputs(env: Record<string, string | undefined>): RawInputs {
  const get = (name: string): string => env[`INPUT_${name}`] ?? "";
  return {
    enable: get("ENABLE"),
    version: get("VERSION"),
    repo: get("REPO"),
    ref: get("REF"),
    cache: get("CACHE"),
    cacheDir: get("CACHE_DIR"),
    cacheKeySuffix: get("CACHE_KEY_SUFFIX"),
    toolchain: get("TOOLCHAIN"),
    toolchainFile: get("TOOLCHAIN_FILE"),
    trustMode: get("TRUST_MODE"),
    linker: get("LINKER"),
    compilePriority: get("COMPILE_PRIORITY"),
    timestamps: get("TIMESTAMPS"),
    lockfile: get("LOCKFILE"),
    buildCache: get("BUILD_CACHE"),
    buildCacheMode: get("BUILD_CACHE_MODE"),
    targetCache: get("TARGET_CACHE"),
    targetCacheMode: get("TARGET_CACHE_MODE"),
    targetDir: get("TARGET_DIR"),
    targetCacheProfile: get("TARGET_CACHE_PROFILE"),
    targetCacheStripDebuginfo: get("TARGET_CACHE_STRIP_DEBUGINFO"),
    targetCacheIncludeIncremental: get("TARGET_CACHE_INCLUDE_INCREMENTAL"),
    targetCacheIncludeBuildScriptBinaries: get("TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"),
    targetCacheCompress: get("TARGET_CACHE_COMPRESS"),
    targetCacheCompressLevel: get("TARGET_CACHE_COMPRESS_LEVEL"),
    sourceMtimeNormalize: get("SOURCE_MTIME_NORMALIZE"),
    cargoRegistryCache: get("CARGO_REGISTRY_CACHE"),
    compileCacheStats: get("COMPILE_CACHE_STATS"),
    shims: get("SHIMS"),
    stats: get("STATS"),
    debugMode: get("DEBUG"),
    cacheShutdownOnIdle: get("CACHE_SHUTDOWN_ON_IDLE"),
  };
}
