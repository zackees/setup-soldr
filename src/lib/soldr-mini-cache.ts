// Soldr-mini-cache — the narrowest cache layer: just the soldr binary,
// keyed only on (version, platform, arch, libc).
//
// Per CLAUDE.md "Layer per change cadence" + "Coarse keys, shared across
// workflows": the soldr binary's invalidation rhythm is per-soldr-release
// (~1×/week). Mixing it into the existing setup-cache (which is keyed on
// toolchain hash + cache-key-suffix) means it re-downloads whenever those
// move — even though the binary content didn't change.
//
// This layer caches *only* the install dir contents (binary + optional
// source-metadata sidecar), keyed coarsely so every workflow in the repo
// pinned to the same soldr version hits the same entry.
//
// Position in the lifecycle:
//   main.ts: try restore → if hit, soldrPath is pre-populated and
//   ensureSoldr's installedVersion check short-circuits the GH fetch.
//   post.ts: if restore missed AND ensureSoldr fetched, save the binary
//   for next time.
//
// Refs (rebuild-from-source) are skipped: the binary content depends on
// the commit, not the version tag, so the cache key would be wrong.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as cache from "@actions/cache";
import { compressCache, decompressCache, detectCompressMagic } from "./cache-compress.js";

export interface MiniCacheKeyParts {
  runnerOs: string;
  runnerArch: string;
  libc: string;
  soldrVersion: string;
}

export interface MiniCacheRestoreOpts {
  exactKey: string;
  installDir: string;
  archivePath: string;
  longWindow: number;
  debug: boolean;
  log: (msg: string) => void;
}

export interface MiniCacheRestoreResult {
  hit: boolean;
  matchedKey: string;
  archiveBytes: number;
}

export interface MiniCacheSaveOpts {
  installDir: string;
  archivePath: string;
  exactKey: string;
  level: string;
  longWindow: number;
  debug: boolean;
  log: (msg: string) => void;
}

export interface MiniCacheSaveResult {
  status: "saved" | "skipped-race" | "skipped-empty" | "skipped-missing-dir" | "failed";
  cacheId?: number;
  archiveBytes?: number;
  inflatedBytes?: number;
  fileCount?: number;
  error?: string;
}

const MINI_KEY_PREFIX = "soldr-mini";

/**
 * Build the mini-cache key. Deliberately coarse — only the dimensions
 * that change soldr's binary content. No toolchain hash, no Cargo.lock,
 * no cache-key-suffix, no SHA. Cross-workflow sharing within a repo.
 */
export function buildMiniCacheKey(parts: MiniCacheKeyParts): string {
  const v = parts.soldrVersion.trim().replace(/^v/, "") || "unresolved";
  return [
    MINI_KEY_PREFIX,
    parts.runnerOs,
    parts.runnerArch,
    parts.libc,
    `v${v}`,
  ].join("-");
}

/**
 * Try to restore the soldr install dir from the mini-cache. Single exact
 * key — content-addressable so a fallback would be wrong. On hit, the
 * caller's normal ensureSoldr() will see the binary already present at
 * the expected path and skip the GH Releases fetch.
 */
export async function restoreMiniCache(opts: MiniCacheRestoreOpts): Promise<MiniCacheRestoreResult> {
  const { exactKey, installDir, archivePath, longWindow, log } = opts;
  await fsp.mkdir(installDir, { recursive: true });
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  await fsp.rm(archivePath, { force: true });
  let matched: string | undefined;
  try {
    matched = await cache.restoreCache([archivePath], exactKey);
  } catch (err) {
    log(`soldr-mini-cache: restore threw: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: "", archiveBytes: 0 };
  }
  if (!matched) {
    log(`soldr-mini-cache: no entry for key ${exactKey}`);
    return { hit: false, matchedKey: "", archiveBytes: 0 };
  }
  let archiveBytes = 0;
  try {
    archiveBytes = (await fsp.stat(archivePath)).size;
  } catch {
    return { hit: false, matchedKey: matched, archiveBytes: 0 };
  }
  const magic = await detectCompressMagic(archivePath);
  if (magic !== "zstd" && magic !== "gzip") {
    log(`soldr-mini-cache: archive has unknown codec, treating as miss`);
    return { hit: false, matchedKey: matched, archiveBytes };
  }
  try {
    await decompressCache({
      archivePath,
      targetDir: installDir,
      longWindow,
      log,
      debug: opts.debug,
    });
  } catch (err) {
    log(`soldr-mini-cache: decompress failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: matched, archiveBytes };
  }
  log(`soldr-mini-cache: restored matched=${matched} archive=${archiveBytes}B target=${installDir}`);
  return { hit: true, matchedKey: matched, archiveBytes };
}

/**
 * Tar+zstd the soldr install dir and upload to cache. Caller should only
 * call this when restore missed AND ensureSoldr actually fetched (otherwise
 * we'd be re-saving the same content).
 */
export async function saveMiniCache(opts: MiniCacheSaveOpts): Promise<MiniCacheSaveResult> {
  const { installDir, archivePath, exactKey, level, longWindow, debug, log } = opts;
  if (!fs.existsSync(installDir)) {
    return { status: "skipped-missing-dir" };
  }
  let entryCount = 0;
  try {
    entryCount = (await fsp.readdir(installDir)).length;
  } catch { /* */ }
  if (entryCount === 0) {
    return { status: "skipped-empty" };
  }
  // compressCache writes to `${cacheDir}.tar.zst` by default. We pass
  // installDir as cacheDir, so the archive ends up at
  // `${installDir}.tar.zst`. The caller's main.ts side uses the same
  // path so @actions/cache hashes the paths array identically on save
  // and restore (mirrors the cook-cache lesson from #141).
  let outputArchivePath: string | null = null;
  let archiveBytes: number | undefined;
  let inflatedBytes: number | undefined;
  let fileCount: number | undefined;
  try {
    const compress = await compressCache({
      cacheDir: installDir,
      codec: "zstd",
      level,
      longWindow,
      debug,
      log,
    });
    outputArchivePath = compress.archivePath;
    archiveBytes = compress.archiveBytes;
    if (compress.inflatedBytes !== null) inflatedBytes = compress.inflatedBytes;
    if (compress.fileCount !== null) fileCount = compress.fileCount;
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (!outputArchivePath) {
    return { status: "failed", error: "compressCache returned null archive (zstd unavailable?)" };
  }
  if (path.resolve(outputArchivePath) !== path.resolve(archivePath)) {
    log(
      `soldr-mini-cache: WARNING archive path mismatch — compress wrote ${outputArchivePath}, ` +
        `expected ${archivePath}. Future restore may miss due to paths-version hash.`,
    );
  }
  try {
    const id = await cache.saveCache([outputArchivePath], exactKey);
    if (id <= 0) {
      log(
        `soldr-mini-cache: save did not reserve a new entry (id=${id}) — likely a parallel ` +
          `job already saved key=${exactKey}`,
      );
      return {
        status: "skipped-race",
        cacheId: id,
        archiveBytes,
        inflatedBytes,
        fileCount,
      };
    }
    log(`soldr-mini-cache: saved id=${id} key=${exactKey} archive=${outputArchivePath}`);
    return {
      status: "saved",
      cacheId: id,
      archiveBytes,
      inflatedBytes,
      fileCount,
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Should we use the mini-cache for this run? Independent of the
 * `soldr-mini-cache` input flag (that gate is checked in main.ts).
 * Returns false when building from source — binary content depends on
 * the commit SHA, not the version tag.
 */
export function isEligibleForMiniCache(opts: {
  hasRef: boolean;
  enable: boolean;
  resolvedVersion: string;
}): { eligible: boolean; reason: string } {
  if (!opts.enable) return { eligible: false, reason: "enable=false (passthrough stub mode)" };
  if (opts.hasRef) {
    return {
      eligible: false,
      reason: "ref is set — building from source, binary depends on commit not version",
    };
  }
  if (!opts.resolvedVersion.trim()) {
    return { eligible: false, reason: "no resolved version available" };
  }
  return { eligible: true, reason: "eligible" };
}
