// Toolchain "solo" cache — long-lived, small, per-platform cache holding
// only what setup-soldr added to $RUSTUP_HOME/toolchains/ and
// $CARGO_HOME/bin/ on top of the runner image baseline.
//
// Foundation layer per CLAUDE.md "Cache-lifetime axis: build the
// foundation first". Wraps `@actions/cache` with a staging-dir-based
// save (so we tar only the diff inodes, not the whole RUSTUP_HOME) and
// a verify-after-restore step (so a corrupt cache entry is treated as
// a miss rather than booby-trapping the run).
//
// Opt-in for v1 via the `solo-toolchain-cache` input. The save path
// short-circuits when the snapshot diff is empty — which is the
// dominant case on hosted runners that already ship rustup + stable.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import { compressCache, decompressCache, detectCompressMagic } from "./cache-compress.js";
import type { SnapshotDiff, SnapshotEntry } from "./toolchain-snapshot.js";

/**
 * The two live roots whose deltas this cache layer tracks. The string keys
 * are also the directory names used inside the tarball staging layout.
 */
const ROOT_TAGS = ["rustup-toolchains", "cargo-bin"] as const;
export type RootTag = (typeof ROOT_TAGS)[number];

/**
 * Canonical archive path passed to `@actions/cache.saveCache` and
 * `restoreCache`. **MUST be identical on both sides.**
 *
 * `@actions/cache` derives a cache "version" from a SHA of the paths
 * array; if save and restore pass different paths, the version differs
 * and restore returns MISS even when the key matches an existing
 * entry. Pre-#316 bug: save used `${stagingDir}.tar.zst` and restore
 * used `<stagingDir>/solo-toolchain.tar.zst` — two different paths
 * → permanent MISS on every warm run. This helper guarantees both
 * sides agree.
 */
export function soloCacheArchivePath(runnerTemp: string): string {
  return path.join(runnerTemp, "setup-soldr-solo-cache.tar.zst");
}

export interface RootMap {
  /** Absolute path to $RUSTUP_HOME/toolchains/ on disk. */
  "rustup-toolchains": string;
  /** Absolute path to $CARGO_HOME/bin/ on disk. */
  "cargo-bin": string;
}

export interface SoloCacheKeyParts {
  runnerOs: string;
  runnerArch: string;
  libc: string;
  rustcRelease: string;
  componentsHash: string;
  targetsHash: string;
  soldrVersion: string;
}

export interface SoloCacheKeys {
  exact: string;
  /**
   * Restore-key ladder. Order is most-specific to least; never drops
   * `os`/`arch`/`libc`/`rustcRelease` per CLAUDE.md "Restore-key
   * fallback ladder".
   */
  fallbacks: string[];
}

export interface SoloRestoreResult {
  hit: boolean;
  matchedKey: string;
  restoredBytes: number;
  archivePath: string | null;
  /**
   * False when the post-restore `rustc --version` check fails to find a
   * matching toolchain. Callers should treat this as if the restore
   * never happened (run ensure-rust-toolchain normally).
   */
  verified: boolean;
}

export interface SoloSaveResult {
  status:
    | "saved"
    | "skipped-empty"
    | "skipped-exact-hit"
    | "skipped-disabled"
    | "race-precheck-skipped"
    | "failed";
  cacheId?: number;
  archiveBytes?: number;
  inflatedBytes?: number;
  fileCount?: number;
  archivePath?: string;
  error?: string;
}

/**
 * Map this run's host platform to a libc tag. Conservative v1: assume
 * glibc on Linux unless we see a musl signal. macOS/Windows have no
 * libc axis, so they get a fixed-string tag that still keeps the cache
 * key shape stable.
 */
export function detectLibc(): string {
  if (process.platform === "linux") {
    if (fs.existsSync("/lib/ld-musl-x86_64.so.1") || fs.existsSync("/lib/ld-musl-aarch64.so.1")) {
      return "musl";
    }
    return "glibc";
  }
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "msvc";
  return "unknown";
}

/**
 * Hash a list of strings deterministically. Sorts first so caller-side
 * order doesn't perturb the key, lowercases for case-insensitive parity
 * across platforms.
 */
export function hashStringArray(items: string[]): string {
  const sorted = [...items.map((s) => s.trim().toLowerCase())].filter((s) => s.length > 0).sort();
  if (sorted.length === 0) return "none";
  const h = createHash("sha256");
  for (const s of sorted) {
    h.update(s);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 8);
}

/**
 * #328: bump this whenever the on-disk format of the solo-cache
 * changes incompatibly with prior versions (tar layout, archive
 * basename, file selection rules, snapshot manifest schema, etc.).
 * A bump forces all consumers to MISS their existing caches and
 * save fresh entries with the new structure — no per-repo manual
 * `gh cache delete` required.
 *
 * History:
 *   v1: initial (#305) through v0.9.41.
 *   v2: bumped for #326 — save's tar top-level dir was renamed
 *       from `setup-soldr-solo-stage-save` to `staged`. v1 caches
 *       are unreadable by v2 restorers ("archive was empty").
 */
const SOLO_CACHE_SCHEMA_VERSION = 2;

export function buildSoloCacheKeys(parts: SoloCacheKeyParts): SoloCacheKeys {
  const release = parts.rustcRelease.trim() || "unresolved";
  const base = `solo-toolchain-v${SOLO_CACHE_SCHEMA_VERSION}-${parts.runnerOs}-${parts.runnerArch}-${parts.libc}-rustc${release}`;
  const exact = `${base}-c${parts.componentsHash}-t${parts.targetsHash}-soldr${parts.soldrVersion}`;
  return {
    exact,
    fallbacks: [
      `${base}-c${parts.componentsHash}-t${parts.targetsHash}-soldr`,
      `${base}-c${parts.componentsHash}-t-soldr`,
      `${base}-c-t-soldr`,
    ],
  };
}

function findRootTag(absRoot: string, rootMap: RootMap): RootTag | null {
  for (const tag of ROOT_TAGS) {
    if (rootMap[tag] === absRoot) return tag;
  }
  return null;
}

async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

/**
 * Copy the inodes named in `diff.added` into a flat staging directory
 * structured as `<stagingDir>/<root-tag>/<relpath>`. The staging dir
 * is what `compressCache` later tars + zstds. Returns the count of
 * actually-copied files (directories and symlinks are recreated rather
 * than copied byte-for-byte).
 */
export async function stageDiffForSave(
  diff: SnapshotDiff,
  rootMap: RootMap,
  stagingDir: string,
): Promise<{ stagedFiles: number; missingFiles: number }> {
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await ensureDir(stagingDir);
  let stagedFiles = 0;
  let missingFiles = 0;
  for (const entry of diff.added) {
    const tag = findRootTag(entry.root, rootMap);
    if (tag === null) continue;
    const src = path.join(entry.root, entry.relpath);
    const dst = path.join(stagingDir, tag, entry.relpath);
    await ensureDir(path.dirname(dst));
    if (entry.kind === "directory") {
      await ensureDir(dst);
      continue;
    }
    if (entry.kind === "symlink") {
      const target = entry.linkTarget ?? "";
      try {
        await fsp.symlink(target, dst);
      } catch {
        // best-effort; restore replays via the same path
      }
      continue;
    }
    try {
      await fsp.copyFile(src, dst);
      stagedFiles += 1;
    } catch {
      missingFiles += 1;
    }
  }
  return { stagedFiles, missingFiles };
}

/**
 * Inverse of stageDiffForSave: copy files from a (just-restored)
 * staging dir back onto the live $RUSTUP_HOME/$CARGO_HOME roots.
 * Existing destination files are overwritten because the cache key
 * pins the exact content the caller wants.
 */
export async function applyStagedToLiveRoots(
  stagingDir: string,
  rootMap: RootMap,
): Promise<{
  appliedFiles: number;
  appliedSymlinks: number;
  hardlinkSuccesses: number;
  copyFallbacks: number;
}> {
  let appliedFiles = 0;
  let appliedSymlinks = 0;
  // #338: track hardlink vs copyFile fallback. On macOS the
  // observed solo_restore is 2-3× slower than Linux; if hardlinks
  // are falling back to copies on most files, that explains it.
  const counters = { hardlink: 0, copy: 0 };
  for (const tag of ROOT_TAGS) {
    const tagRoot = path.join(stagingDir, tag);
    if (!fs.existsSync(tagRoot)) continue;
    const liveRoot = rootMap[tag];
    await ensureDir(liveRoot);
    await walkAndApply(tagRoot, tagRoot, liveRoot, (kind) => {
      if (kind === "file") appliedFiles += 1;
      if (kind === "symlink") appliedSymlinks += 1;
    }, counters);
  }
  return {
    appliedFiles,
    appliedSymlinks,
    hardlinkSuccesses: counters.hardlink,
    copyFallbacks: counters.copy,
  };
}

async function walkAndApply(
  base: string,
  dir: string,
  liveBase: string,
  onApply: (kind: "file" | "symlink") => void,
  counters?: { hardlink: number; copy: number },
): Promise<void> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  for (const d of dirents) {
    const abs = path.join(dir, d.name);
    const rel = path.relative(base, abs);
    const liveAbs = path.join(liveBase, rel);
    if (d.isDirectory()) {
      await ensureDir(liveAbs);
      await walkAndApply(base, abs, liveBase, onApply, counters);
    } else if (d.isSymbolicLink()) {
      const target = await fsp.readlink(abs);
      try {
        await fsp.rm(liveAbs, { force: true });
      } catch { /* */ }
      try {
        await fsp.symlink(target, liveAbs);
        onApply("symlink");
      } catch { /* */ }
    } else if (d.isFile()) {
      await ensureDir(path.dirname(liveAbs));
      // #331: prefer hardlink over copyFile. On hosted runners the
      // staging dir and the live RUSTUP_HOME are on the same
      // filesystem; hardlink is constant-time (creates a new
      // directory entry pointing at the same inode) vs ~5s of
      // sequential copy I/O for the ~580 MB toolchain content.
      // Falls back to copyFile on cross-device (EXDEV) or
      // filesystems that don't allow hardlinks (EPERM).
      try {
        await fsp.link(abs, liveAbs);
        if (counters) counters.hardlink += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          await fsp.unlink(liveAbs).catch(() => undefined);
          try {
            await fsp.link(abs, liveAbs);
            if (counters) counters.hardlink += 1;
          } catch {
            await fsp.copyFile(abs, liveAbs);
            if (counters) counters.copy += 1;
          }
        } else {
          await fsp.copyFile(abs, liveAbs);
          if (counters) counters.copy += 1;
        }
      }
      onApply("file");
    }
  }
}

/**
 * Tar+zstd the staging directory and upload via `@actions/cache`.
 * Caller must have already populated `stagingDir` via stageDiffForSave.
 */
export async function saveSoloCache(opts: {
  stagingDir: string;
  key: string;
  level: string;
  debug: boolean;
  log: (msg: string) => void;
  /**
   * Canonical archive path that BOTH save and restore must pass to
   * @actions/cache (otherwise the cache "version" derived from the
   * paths array differs and restore returns MISS — see #316).
   * Defaults to soloCacheArchivePath(dirname(stagingDir)).
   */
  cacheArchivePath?: string;
}): Promise<SoloSaveResult> {
  const { stagingDir, key, level, debug, log } = opts;
  const cacheArchive = opts.cacheArchivePath ?? soloCacheArchivePath(path.dirname(stagingDir));
  if (!fs.existsSync(stagingDir)) {
    return { status: "failed", error: `staging dir missing: ${stagingDir}` };
  }
  let archivePath: string | null = null;
  let archiveBytes: number | undefined;
  let inflatedBytes: number | undefined;
  let fileCount: number | undefined;
  try {
    const compress = await compressCache({
      cacheDir: stagingDir,
      codec: "zstd",
      level,
      debug,
      log,
      cacheKey: key,
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
  // #316: rename the compress output to the canonical archive path
  // BEFORE passing to cache.saveCache. @actions/cache hashes the paths
  // array into the cache "version" — save+restore must agree on the
  // path or restore returns MISS even when the key matches.
  if (path.resolve(archivePath) !== path.resolve(cacheArchive)) {
    try {
      await fsp.rm(cacheArchive, { force: true });
      await fsp.rename(archivePath, cacheArchive);
      archivePath = cacheArchive;
    } catch (err) {
      return {
        status: "failed",
        error: `failed to rename archive ${archivePath} -> ${cacheArchive}: ${err instanceof Error ? err.message : String(err)}`,
        archivePath,
      };
    }
  }
  // #313 followup: post-compress, pre-upload probe. When N parallel
  // jobs in a workflow all save the same key, the pre-compress probe
  // (post.ts) can't catch the race — all N see no cache. After
  // compress (~10s at -9), the first job's save may have completed;
  // a probe here catches that and skips the wasted upload. The probe
  // requires a non-empty paths array even in lookupOnly mode, hence
  // the throwaway directory.
  try {
    // #316: use the canonical archive path for the probe too. The
    // probe MUST hash the same paths as save+restore so the
    // @actions/cache cache "version" matches; otherwise the probe
    // sees MISS for entries that the actual restore would also miss
    // for the wrong reason (path-version mismatch, not key absence).
    const existing = await cache.restoreCache([cacheArchive], key, [], { lookupOnly: true });
    if (existing) {
      log(`solo-toolchain-cache: post-compress lookupOnly probe found existing key=${existing} — skipping upload (#313)`);
      return {
        status: "race-precheck-skipped",
        archiveBytes,
        inflatedBytes,
        fileCount,
        archivePath,
      };
    }
  } catch (err) {
    log(
      `solo-toolchain-cache: post-compress lookupOnly probe failed (will attempt save anyway): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const id = await cache.saveCache([archivePath], key);
    log(`solo-toolchain-cache: saved id=${id} key=${key} archive=${archivePath}`);
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

/**
 * Try to restore the solo cache. Hits decompress + apply the staged
 * contents to live roots. Misses leave the runtime untouched and the
 * normal ensure-rust-toolchain path proceeds.
 */
export async function restoreSoloCache(opts: {
  keys: SoloCacheKeys;
  rootMap: RootMap;
  stagingDir: string;
  log: (msg: string) => void;
  /**
   * Canonical archive path — must match the one saveSoloCache used,
   * or @actions/cache returns MISS due to version-from-paths mismatch
   * (see #316). Defaults to soloCacheArchivePath(dirname(stagingDir)).
   */
  cacheArchivePath?: string;
}): Promise<SoloRestoreResult> {
  const { keys, rootMap, stagingDir, log } = opts;
  // #316: use the canonical archive path that saveSoloCache also uses.
  // Different paths → different cache version → permanent MISS.
  const archivePath = opts.cacheArchivePath ?? soloCacheArchivePath(path.dirname(stagingDir));
  await ensureDir(path.dirname(archivePath));
  await fsp.rm(archivePath, { force: true });

  let matched: string | undefined;
  try {
    matched = await cache.restoreCache([archivePath], keys.exact, keys.fallbacks);
  } catch (err) {
    log(`solo-toolchain-cache: restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: "", restoredBytes: 0, archivePath: null, verified: false };
  }
  if (!matched) {
    log("solo-toolchain-cache: no cache entry matched any key");
    return { hit: false, matchedKey: "", restoredBytes: 0, archivePath: null, verified: false };
  }
  let archiveBytes = 0;
  try {
    archiveBytes = (await fsp.stat(archivePath)).size;
  } catch {
    // archive may not have actually landed; treat as miss
    return { hit: false, matchedKey: matched, restoredBytes: 0, archivePath: null, verified: false };
  }
  const magic = await detectCompressMagic(archivePath);
  const haveEncryptKey = (process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] ?? "").trim().length > 0;
  if (magic !== "zstd" && magic !== "gzip" && !haveEncryptKey) {
    log(`solo-toolchain-cache: restored archive has unknown codec, treating as miss`);
    return { hit: false, matchedKey: matched, restoredBytes: 0, archivePath, verified: false };
  }
  const stagingOut = path.join(stagingDir, "staged");
  try {
    await fsp.rm(stagingOut, { recursive: true, force: true });
    // matched is the actual key the restored entry was stored under, which
    // is what the encryption AAD was bound to on save.
    await decompressCache({ archivePath, targetDir: stagingOut, cacheKey: matched });
  } catch (err) {
    log(`solo-toolchain-cache: decompress failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: matched, restoredBytes: archiveBytes, archivePath, verified: false };
  }
  // decompressCache extracts to dirname(targetDir)/<basename>/, so the
  // actual staged content lands under stagingOut. Verify by listing.
  const innerDirs = await fsp.readdir(stagingOut).catch(() => [] as string[]);
  if (innerDirs.length === 0) {
    log("solo-toolchain-cache: restored archive was empty");
    return { hit: false, matchedKey: matched, restoredBytes: archiveBytes, archivePath, verified: false };
  }
  try {
    const applied = await applyStagedToLiveRoots(stagingOut, rootMap);
    log(
      `solo-toolchain-cache: restored matched=${matched} archive=${archiveBytes}B ` +
        `applied files=${applied.appliedFiles} symlinks=${applied.appliedSymlinks} ` +
        `hardlinks=${applied.hardlinkSuccesses} copy-fallbacks=${applied.copyFallbacks} ` +
        `(#338 diagnostic)`,
    );
  } catch (err) {
    log(`solo-toolchain-cache: apply failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: matched, restoredBytes: archiveBytes, archivePath, verified: false };
  }
  return {
    hit: matched === keys.exact,
    matchedKey: matched,
    restoredBytes: archiveBytes,
    archivePath,
    verified: true,
  };
}

/**
 * Run `rustc --version` against the toolchain rustup picks by default
 * after a restore, and confirm the release matches the expected
 * `cacheChannel` from ToolchainSpec. Mismatch → caller should treat the
 * restore as a miss.
 *
 * Returns the observed release string (e.g. "1.84.1") and a match flag.
 * `expectedRelease` empty disables the check (returns `match: true`).
 */
export async function verifyRestoredToolchain(opts: {
  expectedRelease: string;
  rustcCommand: string;
  log: (msg: string) => void;
}): Promise<{ match: boolean; observedRelease: string | null }> {
  const { expectedRelease, rustcCommand, log } = opts;
  if (!expectedRelease.trim()) return { match: true, observedRelease: null };
  let stdout = "";
  let code = -1;
  try {
    code = await exec.exec(rustcCommand, ["--version"], {
      silent: true,
      ignoreReturnCode: true,
      listeners: { stdout: (data: Buffer) => { stdout += data.toString("utf8"); } },
    });
  } catch (err) {
    log(`solo-toolchain-cache: rustc --version threw: ${err instanceof Error ? err.message : String(err)}`);
    return { match: false, observedRelease: null };
  }
  if (code !== 0) {
    log(`solo-toolchain-cache: rustc --version exited ${code}; cannot verify restore`);
    return { match: false, observedRelease: null };
  }
  const match = stdout.trim().match(/^rustc\s+(\S+)/);
  const observed = match ? (match[1] ?? null) : null;
  if (observed === null) {
    log(`solo-toolchain-cache: rustc --version output not parseable: ${stdout.trim()}`);
    return { match: false, observedRelease: null };
  }
  const ok = observed === expectedRelease;
  log(
    `solo-toolchain-cache: verify rustc release expected=${expectedRelease} observed=${observed} match=${ok}`,
  );
  return { match: ok, observedRelease: observed };
}
