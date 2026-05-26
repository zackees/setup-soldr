// Cook cache layer — long-lived deps tarball keyed by Cargo.lock content.
//
// Per CLAUDE.md "Cache-lifetime axis" + the cook simulation findings:
// the cook cache is short-lived/large (churns on every Cargo.lock change,
// 100s of MB to multi-GB). It must NOT include SHA in the key (causes
// catastrophic eviction churn). Content-addressable keying gives parent-
// to-branch sharing automatically: same Cargo.lock = same key, regardless
// of branch or commit.
//
// Save path: snapshot `target/` immediately after cook completes, before
// the user's `cargo build` adds project artifacts. We tar+zstd-19 with
// `--long=27` because compiled rust deps have heavy cross-crate
// redundancy that benefits from the 128 MB zstd window.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as exec from "@actions/exec";
import * as cache from "@actions/cache";
import { compressCache, decompressCache, detectCompressMagic } from "./cache-compress.js";

export interface CookCacheKeyParts {
  runnerOs: string;
  runnerArch: string;
  libc: string;
  rustcRelease: string;
  /** Hash of canonical-form cook flags (--release, --target, --workspace, --profile). */
  flagsHash: string;
  /** Hash of the project's Cargo.lock file (short hex). */
  lockHash: string;
  /** soldr version included so a cook output produced by a buggy soldr
   * doesn't survive across soldr upgrades. */
  soldrVersion: string;
}

/** Cook gating decision. */
export interface CookGate {
  enabled: boolean;
  reason: string;
}

export interface CookRunOpts {
  soldrBinary: string;
  projectRoot: string;
  flags: string[];
  log: (msg: string) => void;
}

export interface CookRunResult {
  exitCode: number;
  ranSeconds: number;
}

export interface CookRestoreOpts {
  exactKey: string;
  archivePath: string;
  targetDir: string;
  longWindow: number;
  debug: boolean;
  log: (msg: string) => void;
}

export interface CookRestoreResult {
  hit: boolean;
  matchedKey: string;
  archiveBytes: number;
}

export interface CookSaveOpts {
  targetDir: string;
  exactKey: string;
  level: string;
  longWindow: number;
  debug: boolean;
  log: (msg: string) => void;
}

export interface CookSaveResult {
  status: "saved" | "skipped-race" | "skipped-missing-target" | "skipped-empty" | "failed";
  cacheId?: number;
  archiveBytes?: number;
  inflatedBytes?: number;
  fileCount?: number;
  archivePath?: string;
  error?: string;
}

const COOK_KEY_PREFIX = "cook";
const COOK_MODE = "soldr-cook";
const LEGACY_COOK_MODE = "cargo-chef";

/**
 * Compute the canonical flag fingerprint. Sorts and lowercases so flag
 * order doesn't perturb the key, and so `--release` vs `--RELEASE`
 * collapse. Only flags that affect cook output structure should be
 * here; cosmetic flags must be filtered upstream.
 */
export function hashCookFlags(flags: string[]): string {
  const sorted = [...flags.map((s) => s.trim()).filter((s) => s.length > 0)].sort();
  if (sorted.length === 0) return "none";
  const h = createHash("sha256");
  for (const s of sorted) {
    h.update(s);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 8);
}

export function buildCookCacheKey(parts: CookCacheKeyParts): string {
  const release = parts.rustcRelease.trim() || "unresolved";
  return [
    COOK_KEY_PREFIX,
    parts.runnerOs,
    parts.runnerArch,
    parts.libc,
    `rustc${release}`,
    `f${parts.flagsHash}`,
    `l${parts.lockHash}`,
    `soldr${parts.soldrVersion}`,
  ].join("-");
}

export function isCookMode(mode: string): boolean {
  const normalized = mode.trim().toLowerCase();
  return normalized === COOK_MODE || normalized === LEGACY_COOK_MODE;
}

/**
 * Decide whether to run cook based on the runtime environment. Returns a
 * reason string for diagnostic logging in both branches.
 */
export function decideCookGate(opts: {
  prebuildDeps: string;
  cacheUmbrella: boolean;
  lockfilePath: string;
}): CookGate {
  const mode = opts.prebuildDeps.trim().toLowerCase();
  if (mode === "" || mode === "none" || mode === "off" || mode === "false") {
    return { enabled: false, reason: `prebuild-deps=${opts.prebuildDeps || "(empty)"} - cook disabled` };
  }
  if (!isCookMode(mode)) {
    return {
      enabled: false,
      reason:
        `prebuild-deps=${opts.prebuildDeps} - unknown strategy, ` +
        `only "${COOK_MODE}" supported ("${LEGACY_COOK_MODE}" remains an alias)`,
    };
  }
  if (!opts.cacheUmbrella) {
    return { enabled: false, reason: "cache: false - cook produces no value without caching" };
  }
  if (!opts.lockfilePath) {
    return { enabled: false, reason: "no Cargo.lock found - cook needs a lockfile to derive recipe" };
  }
  if (!fs.existsSync(opts.lockfilePath)) {
    return { enabled: false, reason: `Cargo.lock path ${opts.lockfilePath} does not exist` };
  }
  return { enabled: true, reason: `${COOK_MODE} enabled` };
}

/**
 * Run `soldr cook` in the project directory. The soldr-cook mode emits
 * the recipe and runs the dependency compile. We tolerate failure: cook
 * is an optimization, not a correctness primitive, so any non-zero exit
 * is logged and the action proceeds. The user's normal `cargo build`
 * step will work fine without a cooked target.
 */
export async function runCook(opts: CookRunOpts): Promise<CookRunResult> {
  const { soldrBinary, projectRoot, flags, log } = opts;
  log(`cook: running '${soldrBinary} cook ${flags.join(" ")}' in ${projectRoot}`);
  const t0 = Date.now();
  let exitCode = 0;
  try {
    exitCode = await exec.exec(soldrBinary, ["cook", ...flags], {
      cwd: projectRoot,
      ignoreReturnCode: true,
    });
  } catch (err) {
    log(`cook: exec threw: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  }
  const ranSeconds = (Date.now() - t0) / 1000;
  if (exitCode !== 0) {
    log(`cook: failed with exit ${exitCode} after ${ranSeconds.toFixed(1)}s; continuing without cooked deps`);
  } else {
    log(`cook: completed in ${ranSeconds.toFixed(1)}s`);
  }
  return { exitCode, ranSeconds };
}

/**
 * Attempt to restore a cooked target directory from the actions cache.
 * Single exact key — no fallback ladder; cook is content-addressable so
 * a fallback would either be redundant or wrong.
 */
export async function restoreCookCache(opts: CookRestoreOpts): Promise<CookRestoreResult> {
  const { exactKey, archivePath, targetDir, longWindow, log } = opts;
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  await fsp.rm(archivePath, { force: true });
  let matched: string | undefined;
  try {
    matched = await cache.restoreCache([archivePath], exactKey);
  } catch (err) {
    log(`cook-cache: restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: "", archiveBytes: 0 };
  }
  if (!matched) {
    log(`cook-cache: no entry for key ${exactKey}`);
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
    log(`cook-cache: restored archive has unknown codec, treating as miss`);
    return { hit: false, matchedKey: matched, archiveBytes };
  }
  await fsp.mkdir(targetDir, { recursive: true });
  try {
    await decompressCache({
      archivePath,
      targetDir,
      longWindow,
      log,
      debug: opts.debug,
    });
  } catch (err) {
    log(`cook-cache: decompress failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: matched, archiveBytes };
  }
  log(`cook-cache: restored matched=${matched} archive=${archiveBytes}B target=${targetDir}`);
  return { hit: true, matchedKey: matched, archiveBytes };
}

/**
 * Tar+zstd the post-cook target directory and upload via actions cache.
 * Caller passes the same `longWindow` as the restore side so the archive
 * is readable on subsequent runs.
 */
export async function saveCookCache(opts: CookSaveOpts): Promise<CookSaveResult> {
  const { targetDir, exactKey, level, longWindow, debug, log } = opts;
  if (!fs.existsSync(targetDir)) {
    return { status: "skipped-missing-target" };
  }
  // Bail if the directory is effectively empty — cook should have produced
  // *something*; an empty target dir indicates cook failed silently or the
  // gate let us through when it shouldn't have.
  let entryCount = 0;
  try {
    entryCount = (await fsp.readdir(targetDir)).length;
  } catch { /* */ }
  if (entryCount === 0) {
    return { status: "skipped-empty" };
  }
  let archivePath: string | null = null;
  let archiveBytes: number | undefined;
  let inflatedBytes: number | undefined;
  let fileCount: number | undefined;
  try {
    const compress = await compressCache({
      cacheDir: targetDir,
      codec: "zstd",
      level,
      longWindow,
      debug,
      log,
    });
    archivePath = compress.archivePath;
    archiveBytes = compress.archiveBytes;
    if (compress.inflatedBytes !== null) inflatedBytes = compress.inflatedBytes;
    if (compress.fileCount !== null) fileCount = compress.fileCount;
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (!archivePath) {
    return { status: "failed", error: "compressCache returned null archive (zstd unavailable?)" };
  }
  try {
    const id = await cache.saveCache([archivePath], exactKey);
    if (id <= 0) {
      // @actions/cache returns -1 when reserveCache fails — typically
      // because the key already exists (parallel job got there first)
      // or the cache budget is exhausted. Not an error: future runs
      // will hit the entry the other job saved.
      log(
        `cook-cache: save did not reserve a new entry (id=${id}) — likely a parallel ` +
          `job already saved key=${exactKey} or repo cache budget is exhausted`,
      );
      return {
        status: "skipped-race",
        cacheId: id,
        archiveBytes,
        inflatedBytes,
        fileCount,
        archivePath,
      };
    }
    log(`cook-cache: saved id=${id} key=${exactKey} archive=${archivePath}`);
    return {
      status: "saved",
      cacheId: id,
      archiveBytes,
      inflatedBytes,
      fileCount,
      archivePath,
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      archivePath,
    };
  }
}

/** Tokenize a free-form flags string into a flags array. Whitespace-split. */
export function parseCookFlags(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * From a flags array, extract only the tokens that materially affect cook
 * output structure for hashing. Excludes verbosity / colour flags.
 *
 * Conservative: keep anything that isn't on a known-cosmetic list. This
 * over-keys (extra misses on cosmetic-only changes) rather than under-keys
 * (serving stale cooked artifacts under a key that doesn't reflect them).
 */
export function canonicalizeCookFlags(flags: string[]): string[] {
  const COSMETIC = new Set([
    "--verbose", "-v", "-vv", "--quiet", "-q",
    "--color=auto", "--color=always", "--color=never",
    "--no-default-features", // affects output; KEEP — moved out below
  ]);
  COSMETIC.delete("--no-default-features"); // safety net for the comment above
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i] as string;
    if (COSMETIC.has(f)) continue;
    if (f === "--color" || f === "--message-format") {
      i += 1; // skip the value
      continue;
    }
    out.push(f);
  }
  return out;
}
