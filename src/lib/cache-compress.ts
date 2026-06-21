// Tar+zstd cache compression helpers. Owned by Agent 2.
//
// Used by src/main.ts (restore: auto-detect .tar.zst, decompress in place)
// and src/post.ts (save: tar+zstd the cache dir).
//
// Acceptance criterion #1 + #2 of zackees/setup-soldr#70: post-job tar+zstd
// at level configured by target-cache-compress-level, restore auto-detects
// zstd vs gzip magic bytes for back-compat.

import * as fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import type {
  CachePayloadCensus,
  CachePayloadEntry,
  CachePayloadSkipSummary,
  CachePayloadSubtree,
} from "./types.js";
import {
  decryptedTempPathFor,
  decryptFile,
  encryptFile,
  getEncryptionConfig,
  isEncryptedArchive,
  type EncryptionConfig,
} from "./cache-encrypt.js";

/**
 * Resolve the encryption config for a cache call. Callers pass `encryption`
 * explicitly for tests; in production they pass `cacheKey` and let the
 * helper read SETUP_SOLDR_CACHE_ENCRYPT_KEY off `env` itself. When the env
 * key is set but no cacheKey is supplied, returns null + emits a warning —
 * we refuse to encrypt with an empty AAD, which would defeat the cross-
 * layer replay protection the AAD is there to provide.
 */
function resolveCacheEncryption(opts: {
  explicit: EncryptionConfig | null | undefined;
  cacheKey: string | undefined;
  env?: Record<string, string | undefined>;
  warn?: (msg: string) => void;
}): EncryptionConfig | null {
  if (opts.explicit !== undefined) {
    return opts.explicit ?? null;
  }
  const env = opts.env ?? process.env;
  const haveKey = (env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] ?? "").trim().length > 0;
  if (!haveKey) return null;
  if (!opts.cacheKey) {
    (opts.warn ?? core.warning)(
      "setup-soldr: cache-encrypt-key is configured but the cache layer did not supply a cacheKey for AAD; skipping encryption for this archive",
    );
    return null;
  }
  return getEncryptionConfig({ env, cacheKey: opts.cacheKey });
}

/**
 * Recursively walk a directory and sum file sizes.
 */
export async function walkDirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  async function walk(d: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.stat(full)).size;
          files++;
        } catch {
          // skip inaccessible files
        }
      }
    }
  }
  await walk(dir);
  return { bytes, files };
}

function fmtBytesDebug(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

const DEFAULT_PAYLOAD_TOP_N = 10;
const MAX_SKIP_SAMPLES = 8;

export type CachePayloadProfile = "generic" | "zccache-build-cache";

const TRANSIENT_EXACT_BASENAMES = new Set([
  ".package-cache",
  ".package-cache-mutate",
  "zccache.pid",
  "sccache.pid",
]);

const ARCHIVE_SUFFIXES = [
  ".tar",
  ".tar.zst",
  ".tar.gz",
  ".tgz",
  ".zip",
  ".zst.tmp",
];

const TRANSIENT_SUFFIXES: Array<[string, string]> = [
  [".sock", "transient-socket-path"],
  [".socket", "transient-socket-path"],
  [".pid", "transient-pid-file"],
  [".lock", "transient-lock-file"],
  [".lck", "transient-lock-file"],
  [".tmp", "transient-temp-file"],
  [".temp", "transient-temp-file"],
  [".part", "transient-temp-file"],
  [".partial", "transient-temp-file"],
];

// ---------------------------------------------------------------------------
// Build-cache payload file-class contract (issue #229).
//
// The zccache build-cache save profile has an explicit, tested allow/deny
// contract so a future refactor can't silently start vacuuming diagnostic
// sidecars into the cache (or, worse, start dropping reusable artifacts):
//
//   ALLOW (always kept): anything under a zccache *artifacts* directory —
//     `zccache/artifacts/**` and `zccache/private/<session>/artifacts/**`.
//     These hold the reusable compiled artifacts AND the compiler
//     stdout/stderr replay metadata zccache stores alongside them, so a
//     `.stderr`/`.out`/`.txt` *inside* an artifacts dir is replay data, not a
//     standalone log, and must survive (see #398 — excluding private
//     artifacts produced restored-but-0-hit caches).
//
//   DENY (trimmed): the `logs/` subtree at any depth (reason
//     `diagnostic-log-dir`) and standalone diagnostic sidecars matching
//     BUILD_CACHE_DENIED_DIAGNOSTIC_SUFFIXES *outside* any artifacts dir
//     (reason `diagnostic-log-file`).
// ---------------------------------------------------------------------------

/** Standalone diagnostic/log sidecar suffixes denied outside artifacts dirs. */
export const BUILD_CACHE_DENIED_DIAGNOSTIC_SUFFIXES = [
  ".jsonl",
  ".log",
  ".trace",
  ".txt",
  ".out",
  ".err",
  ".stdout",
  ".stderr",
] as const;

/**
 * True when a build-cache tar path is inside a zccache artifacts directory —
 * the allowlist that preserves reusable artifacts and their in-place compiler
 * stdout/stderr replay metadata. Matches `zccache/artifacts/**` and
 * `zccache/private/<session>/artifacts/**`. Pure; tar path uses "/" separators.
 */
export function isZccacheArtifactPayloadPath(tarPath: string): boolean {
  const parts = tarPath.split("/").map((part) => part.toLowerCase());
  if (parts[0] !== "zccache") return false;
  if (parts[1] === "artifacts") return true;
  if (parts[1] === "private" && parts.length >= 4 && parts[3] === "artifacts") return true;
  return false;
}

function normalizeTopN(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAYLOAD_TOP_N;
  return Math.max(0, Math.min(50, Math.floor(value)));
}

function comparePayloadEntry(a: CachePayloadEntry, b: CachePayloadEntry): number {
  if (a.bytes !== b.bytes) return b.bytes - a.bytes;
  return a.path.localeCompare(b.path);
}

function toTarPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function reasonForTransientBasename(name: string): string | null {
  const lower = name.toLowerCase();
  if (TRANSIENT_EXACT_BASENAMES.has(lower)) return "transient-cargo-mutex";
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix)) return "archive-file";
  }
  for (const [suffix, reason] of TRANSIENT_SUFFIXES) {
    if (lower.endsWith(suffix)) return reason;
  }
  return null;
}

function reasonForTransientPath(relativePath: string, profile: CachePayloadProfile): string | null {
  const tarPath = toTarPath(relativePath);
  const parts = tarPath.split("/");
  if (parts.length >= 2 && parts[1]?.toLowerCase() === "logs") {
    return "diagnostic-log-dir";
  }
  if (profile === "zccache-build-cache" && parts[0]?.toLowerCase() === "zccache") {
    const lowerParts = parts.map((part) => part.toLowerCase());
    if (lowerParts.includes("logs")) {
      return "diagnostic-log-dir";
    }
    // setup-soldr#398: do NOT exclude `private/<session>/artifacts/**`. That is
    // exactly where the zccache daemon stores its reusable compiled artifacts —
    // excluding them produced a build-cache that restored with an exact key hit
    // but 0 zccache hits (verified on real zccache CI + locally: tarring the
    // store WITH these artifacts restores ~100% hits, WITHOUT them 0%). The
    // allow rule below (isZccacheArtifactPayloadPath) keeps every file under an
    // artifacts dir — including the compiler stdout/stderr replay metadata
    // zccache stores there — so the diagnostic-suffix filter never drops a real
    // artifact file. See the BUILD_CACHE_*_SUFFIXES contract above (#229).
    const isArtifactPayload = isZccacheArtifactPayloadPath(lowerParts.join("/"));
    const basename = lowerParts[lowerParts.length - 1] ?? "";
    if (
      !isArtifactPayload &&
      BUILD_CACHE_DENIED_DIAGNOSTIC_SUFFIXES.some((suffix) => basename.endsWith(suffix))
    ) {
      return "diagnostic-log-file";
    }
  }
  return null;
}

function payloadSubtreePath(tarPath: string, profile: CachePayloadProfile): string {
  const parts = tarPath.split("/");
  if (profile === "zccache-build-cache" && parts[0] === "zccache") {
    if (parts[1] === "private" && parts.length >= 3) {
      return parts.slice(0, 3).join("/");
    }
    if (parts.length >= 3) {
      return parts.slice(0, 2).join("/");
    }
    return "zccache";
  }
  if (parts.length <= 2) {
    return parts[0] ?? tarPath;
  }
  return parts.slice(0, 2).join("/");
}

function reasonForSpecialFile(stats: Stats): string {
  if (stats.isSocket()) return "special-socket";
  if (stats.isFIFO()) return "special-fifo";
  if (stats.isBlockDevice()) return "special-block-device";
  if (stats.isCharacterDevice()) return "special-character-device";
  return "unsupported-file-type";
}

function reasonForAccessError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return "vanished";
  if (code === "EACCES" || code === "EPERM") return "inaccessible";
  return "inaccessible";
}

function hasManifestUnsafeName(relativePath: string): boolean {
  return relativePath.includes("\n") || relativePath.includes("\r");
}

interface MutableSkipSummary {
  reason: string;
  count: number;
  samples: string[];
}

function makeSkipRecorder(): {
  add(reason: string, sample: string): void;
  summaries(): CachePayloadSkipSummary[];
} {
  const skipped = new Map<string, MutableSkipSummary>();
  return {
    add(reason: string, sample: string): void {
      const current = skipped.get(reason) ?? { reason, count: 0, samples: [] };
      current.count++;
      if (current.samples.length < MAX_SKIP_SAMPLES) {
        current.samples.push(sample);
      }
      skipped.set(reason, current);
    },
    summaries(): CachePayloadSkipSummary[] {
      return Array.from(skipped.values()).sort((a, b) => a.reason.localeCompare(b.reason));
    },
  };
}

export type CompressMagic = "zstd" | "gzip" | "unknown";

/**
 * Read the first 4 bytes of a file and identify the compression codec.
 *   zstd:  0x28 B5 2F FD
 *   gzip:  0x1F 8B
 */
export async function detectCompressMagic(filePath: string): Promise<CompressMagic> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    if (bytesRead >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
      return "zstd";
    }
    if (bytesRead >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return "gzip";
    }
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface TarPayloadPlan extends CachePayloadCensus {
  manifestEntries: string[];
}

interface WalkResult {
  bytes: number;
  files: number;
  symlinks: number;
  directories: number;
}

const EMPTY_WALK: WalkResult = {
  bytes: 0,
  files: 0,
  symlinks: 0,
  directories: 0,
};

/**
 * Preflight every tar input with lstat before compression.
 *
 * This keeps daemon sockets, cargo mutex files, partial archives, and other
 * transient/special files out of the manifest that tar receives. Symlinks are
 * archived as symlink entries and are not followed, so links pointing outside
 * the cache root do not pull external content into the cache.
 */
export async function planTarPayload(opts: {
  parent: string;
  inputBasenames: string[];
  topN?: number;
  profile?: CachePayloadProfile;
}): Promise<TarPayloadPlan> {
  const topN = normalizeTopN(opts.topN);
  const profile = opts.profile ?? "generic";
  const skip = makeSkipRecorder();
  const manifestEntries: string[] = [];
  const fileEntries: CachePayloadEntry[] = [];
  const dirEntries: CachePayloadEntry[] = [];
  const subtreeEntries = new Map<string, CachePayloadSubtree>();
  const inputs: string[] = [];

  const addSubtreeFile = (tarPath: string, bytes: number): void => {
    const group = payloadSubtreePath(tarPath, profile);
    const current = subtreeEntries.get(group) ?? { path: group, bytes: 0, files: 0 };
    current.bytes += bytes;
    current.files++;
    subtreeEntries.set(group, current);
  };

  const walk = async (absolutePath: string, relativePath: string): Promise<WalkResult> => {
    if (hasManifestUnsafeName(relativePath)) {
      skip.add("unsupported-name", toTarPath(relativePath));
      return EMPTY_WALK;
    }

    const transientReason = reasonForTransientBasename(path.basename(relativePath));
    if (transientReason) {
      skip.add(transientReason, toTarPath(relativePath));
      return EMPTY_WALK;
    }

    const transientPathReason = reasonForTransientPath(relativePath, profile);
    if (transientPathReason) {
      skip.add(transientPathReason, toTarPath(relativePath));
      return EMPTY_WALK;
    }

    let stats: Stats;
    try {
      stats = await fs.lstat(absolutePath);
    } catch (err) {
      skip.add(reasonForAccessError(err), toTarPath(relativePath));
      return EMPTY_WALK;
    }

    const tarPath = toTarPath(relativePath);
    if (stats.isSymbolicLink()) {
      manifestEntries.push(tarPath);
      return { ...EMPTY_WALK, symlinks: 1 };
    }

    if (stats.isFile()) {
      manifestEntries.push(tarPath);
      fileEntries.push({ path: tarPath, bytes: stats.size });
      addSubtreeFile(tarPath, stats.size);
      return { bytes: stats.size, files: 1, symlinks: 0, directories: 0 };
    }

    if (!stats.isDirectory()) {
      skip.add(reasonForSpecialFile(stats), tarPath);
      return EMPTY_WALK;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(absolutePath, { withFileTypes: true });
    } catch (err) {
      skip.add(reasonForAccessError(err), tarPath);
      return EMPTY_WALK;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    let bytes = 0;
    let files = 0;
    let symlinks = 0;
    let directories = 1;
    for (const entry of entries) {
      const childRelative = path.join(relativePath, entry.name);
      const child = await walk(path.join(absolutePath, entry.name), childRelative);
      bytes += child.bytes;
      files += child.files;
      symlinks += child.symlinks;
      directories += child.directories;
    }
    dirEntries.push({ path: tarPath, bytes });
    return { bytes, files, symlinks, directories };
  };

  let bytes = 0;
  let files = 0;
  let symlinks = 0;
  let directories = 0;
  const seen = new Set<string>();
  for (const rawBasename of opts.inputBasenames) {
    const basename = rawBasename.trim();
    if (!basename || seen.has(basename)) continue;
    seen.add(basename);

    if (
      path.isAbsolute(basename) ||
      basename === "." ||
      basename === ".." ||
      basename.includes("/") ||
      basename.includes("\\")
    ) {
      skip.add("unsupported-input-basename", basename);
      continue;
    }

    inputs.push(basename);
    const result = await walk(path.join(opts.parent, basename), basename);
    bytes += result.bytes;
    files += result.files;
    symlinks += result.symlinks;
    directories += result.directories;
  }

  fileEntries.sort(comparePayloadEntry);
  dirEntries.sort(comparePayloadEntry);
  const topSubtrees = Array.from(subtreeEntries.values()).sort((a, b) => {
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    if (a.files !== b.files) return b.files - a.files;
    return a.path.localeCompare(b.path);
  });

  return {
    bytes,
    files,
    symlinks,
    directories,
    inputs,
    topFiles: fileEntries.slice(0, topN),
    topDirectories: dirEntries.slice(0, topN),
    topSubtrees: topSubtrees.slice(0, topN),
    skipped: skip.summaries(),
    manifestEntries,
  };
}

function publicPayload(plan: TarPayloadPlan): CachePayloadCensus {
  return {
    bytes: plan.bytes,
    files: plan.files,
    symlinks: plan.symlinks,
    directories: plan.directories,
    inputs: plan.inputs,
    topFiles: plan.topFiles,
    topDirectories: plan.topDirectories,
    topSubtrees: plan.topSubtrees,
    skipped: plan.skipped,
  };
}

export interface DecompressResult {
  archiveBytes: number;
  inflatedBytes: number;
  fileCount: number;
}

/**
 * Decompress <cache-dir>.tar.zst (or .tar.gz) into <cache-dir>.
 *
 *   zstd: `zstd -d <archive>` piped into `tar -xf - -C <extractRoot>`.
 *   gzip: `tar -xzf <archive> -C <extractRoot>`.
 *
 * `extractRoot` is `dirname(targetDir)` because compressCache writes
 * archives via `tar -cf - -C <parent> <basename>` — the archive's
 * top-level directory IS `<basename>`. If we extract into <targetDir>
 * directly, that <basename> gets nested twice and the contents end up
 * at <targetDir>/<basename>/... where zccache and cargo can't find them.
 * That double-nesting is the root cause of the long-standing zccache
 * "0 hits despite restored artifacts" symptom.
 *
 * Returns compressed/inflated byte counts and file count (the count is
 * taken from <targetDir> after extraction, so consumers see exactly
 * what landed in the cache dir).
 * When debug=true, logs diagnostics via the supplied log fn.
 */
export async function decompressCache(opts: {
  archivePath: string;
  targetDir: string;
  debug?: boolean;
  log?: (msg: string) => void;
  /**
   * Pass-through to zstd's `--long=<n>` flag. Required when decompressing an
   * archive that was compressed with `--long` (otherwise zstd refuses with
   * "Frame requires too much memory"). Default unset → zstd's 8 MB window.
   * Long mode also needs `--memory=...` reflected if very large; we set
   * `--memory` to match `1 << longWindow` for symmetry.
   */
  longWindow?: number;
  /**
   * #387 Feature 1. Optional AES-256-GCM decryption config. When the
   * restored archive starts with the SOLDRENC magic, it is decrypted to a
   * sibling temp file before the existing zstd/gzip decompression runs;
   * the temp file is removed in `finally`. When the config is null/absent
   * and the archive IS encrypted, decompressCache throws (the caller
   * should then drop the cache entry and treat it as a miss). When the
   * archive is plaintext and the config is present, we accept it for
   * mixed-mode tolerance — log a one-line warning so future saves are
   * known to encrypt.
   *
   * Explicit `null` means "do not auto-load from env"; leaving it
   * `undefined` lets cacheKey + SETUP_SOLDR_CACHE_ENCRYPT_KEY produce
   * one automatically.
   */
  encryption?: EncryptionConfig | null;
  /**
   * Cache key for AAD derivation. Used only when `encryption` is left
   * undefined and the env-supplied key is present. Pass the same string
   * the caller will hand to actions/cache for restore/save.
   */
  cacheKey?: string;
}): Promise<DecompressResult> {
  const {
    archivePath,
    targetDir,
    debug = false,
    log = (): void => undefined,
    longWindow,
  } = opts;
  const encryption = resolveCacheEncryption({
    explicit: opts.encryption,
    cacheKey: opts.cacheKey,
  });
  // Ensure both <targetDir> exists (zccache may have already populated it)
  // and the extract root (which is the parent) is writable.
  await ensureDir(targetDir);
  const extractRoot = path.dirname(targetDir);
  await ensureDir(extractRoot);

  let archiveBytes = 0;
  try { archiveBytes = (await fs.stat(archivePath)).size; } catch { /* archive may not exist */ }

  // #387 Feature 1: detect encrypted archive BEFORE the zstd/gzip sniff. When
  // an encrypted entry is restored without a configured key, the caller can't
  // do anything safe with it — we surface the situation as an Error tagged
  // with `cause.code === "EENCNOKEY"` so the caller decides whether to skip
  // the layer (cold miss) or fail the step.
  const archiveIsEncrypted = await isEncryptedArchive(archivePath);
  let effectiveArchivePath = archivePath;
  let decryptedTempPath: string | null = null;
  try {
    if (archiveIsEncrypted) {
      if (!encryption) {
        const err = new Error(
          `decompressCache: archive ${path.basename(archivePath)} is encrypted but no cache-encrypt-key is configured`,
        );
        (err as NodeJS.ErrnoException).code = "EENCNOKEY";
        throw err;
      }
      decryptedTempPath = decryptedTempPathFor(archivePath);
      if (debug) {
        log(`[debug] decrypt ${path.basename(archivePath)} → ${path.basename(decryptedTempPath)} (AES-256-GCM, archive=${fmtBytesDebug(archiveBytes)})`);
      }
      try {
        await decryptFile(archivePath, decryptedTempPath, encryption);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EAUTHFAIL") {
          // Re-throw with a clearer top-level message; the caller (cache layer)
          // is responsible for rendering this in red and respecting onFailure.
          const wrapped = new Error(
            `decompressCache: failed to authenticate encrypted archive ${path.basename(archivePath)} ` +
              `(wrong cache-encrypt-key, tampered ciphertext, or AAD mismatch)`,
          );
          (wrapped as NodeJS.ErrnoException).code = "EAUTHFAIL";
          throw wrapped;
        }
        throw err;
      }
      effectiveArchivePath = decryptedTempPath;
    } else if (encryption) {
      log(
        `setup-soldr: ${path.basename(archivePath)} is a legacy plaintext cache entry; accepting it this run, the next save will write encrypted`,
      );
    }
    return await decompressInner({
      archivePath: effectiveArchivePath,
      targetDir,
      extractRoot,
      archiveBytes,
      debug,
      log,
      longWindow,
    });
  } finally {
    if (decryptedTempPath) {
      await fs.rm(decryptedTempPath, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Internal: pre-#387 decompression body, extracted so the encryption
 * wrapper above stays focused on auth / dispatch.
 */
async function decompressInner(opts: {
  archivePath: string;
  targetDir: string;
  extractRoot: string;
  archiveBytes: number;
  debug: boolean;
  log: (msg: string) => void;
  longWindow?: number;
}): Promise<DecompressResult> {
  const { archivePath, targetDir, extractRoot, archiveBytes, debug, log, longWindow } = opts;
  const magic = await detectCompressMagic(archivePath);
  if (debug) {
    log(`[debug] decompress ${path.basename(archivePath)}: magic=${magic} archive=${fmtBytesDebug(archiveBytes)}`);
  }

  if (magic === "gzip") {
    if (debug) log(`[debug] decompress cmd: tar -xzf ${archivePath} -C ${extractRoot}`);
    await exec.exec("tar", ["-xzf", archivePath, "-C", extractRoot]);
  } else if (magic === "zstd") {
    const zstdPath = await io.which("zstd", false);
    const longFlag = typeof longWindow === "number" ? [`--long=${longWindow}`] : [];
    // #295 Fix A: pass `-T0` so zstd uses all available CPU cores for
    // decompression. On a 4-vCPU hosted Linux runner this typically
    // drops a multi-GiB build-cache restore from ~17s (single-threaded
    // at ~60 MB/s) to ~5-7s (~200+ MB/s). `-T0` is supported by all
    // zstd ≥ 1.3.2 (Aug 2017) and is a no-op on single-core hosts —
    // safe to add unconditionally. Bench reference:
    // https://facebook.github.io/zstd/#benchmarks
    const threadsFlag = ["-T0"];
    if (!zstdPath) {
      if (debug) log(`[debug] decompress cmd (fallback): tar --use-compress-program "zstd -d -T0${longFlag.length ? ` --long=${longWindow}` : ""}" -xf ${archivePath} -C ${extractRoot}`);
      // Fall back: route the decompression through tar's --use-compress-program
      // so we can pass through --long when the archive needs it. tar --zstd
      // doesn't accept extra zstd flags directly.
      const program = longFlag.length ? `zstd -d -T0 --long=${longWindow}` : "zstd -d -T0";
      await exec.exec("tar", ["--use-compress-program", program, "-xf", archivePath, "-C", extractRoot]);
    } else {
      if (debug) log(`[debug] decompress cmd: zstd -d -T0 ${longFlag.join(" ")} -c ${archivePath} | tar -xf - -C ${extractRoot}`);
      await runPipe(
        [zstdPath, ["-d", ...threadsFlag, ...longFlag, "-c", archivePath]],
        ["tar", ["-xf", "-", "-C", extractRoot]],
      );
    }
  } else {
    throw new Error(`decompressCache: unrecognized archive magic for ${archivePath}`);
  }

  const { bytes: inflatedBytes, files: fileCount } = await walkDirSize(targetDir);
  if (debug) {
    const ratio = archiveBytes > 0 && inflatedBytes > 0 ? (archiveBytes / inflatedBytes).toFixed(2) : "n/a";
    log(`[debug] decompress result: inflated=${fmtBytesDebug(inflatedBytes)} files=${fileCount} ratio=${ratio}`);
  }
  return { archiveBytes, inflatedBytes, fileCount };
}

export interface CompressResult {
  archivePath: string | null;
  archiveBytes: number;
  inflatedBytes: number | null;
  fileCount: number | null;
  payload: CachePayloadCensus | null;
  skippedReason?: "payload-too-large";
}

/**
 * tar -cf - <cache-dir-basename> | zstd -T0 -<level> > <cache-dir>.tar.zst
 *
 * When codec=="none" or zstd is not installed, returns archivePath=null and
 * leaves the caller to use the default actions/cache compression.
 * When debug=true, walks the source dir for byte/file counts and logs ratios.
 */
export async function compressCache(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
  debug?: boolean;
  log?: (msg: string) => void;
  /**
   * Pass-through to zstd's `--long=<n>` flag. 27 = 128 MB window — needed
   * to capture cross-crate redundancy in large `target/deps/` trees. Default
   * unset → 8 MB window. Pair with the same `longWindow` on decompressCache.
   */
  longWindow?: number;
  /**
   * Pass-through to zstd's `--ultra` flag. Required for levels 20–22.
   * Default unset → zstd refuses levels above 19. We don't currently use
   * ultra anywhere; included for completeness.
   */
  ultra?: boolean;
  /**
   * Optional sibling basenames (relative to `dirname(cacheDir)`) to bundle
   * into the same archive. Used by the cargo-registry cache layer to ship
   * `~/.cargo/registry`, `~/.cargo/.global-cache`, and `~/.cargo/git` in a
   * single tarball without touching the public archive path / cache key
   * shape — see setup-soldr#102. Missing basenames are silently skipped so
   * a fresh checkout (no `git/` deps cloned yet) doesn't fail the save.
   * Archive layout matches today's: each basename becomes a top-level entry
   * under the shared parent, so `tar -xf - -C <parent>` restores all of
   * them with no decompressCache changes required.
   */
  extraBasenames?: string[];
  /** Cache payload warning threshold in uncompressed bytes. null/undefined disables warnings. */
  payloadWarnBytes?: number | null;
  /** Cache payload hard limit in uncompressed bytes. null/undefined disables the hard limit. */
  payloadMaxBytes?: number | null;
  /** Behavior when payloadMaxBytes is exceeded. Defaults to "skip". */
  payloadOversizeAction?: "skip" | "fail";
  /** Number of largest files/directories to retain in the payload census. */
  payloadTopN?: number;
  /** Cache-specific pruning/audit profile. */
  payloadProfile?: CachePayloadProfile;
  /** Human-readable cache label used in warning/debug output. */
  label?: string;
  /**
   * #387 Feature 1. Optional AES-256-GCM encryption config. When set, the
   * .tar.zst archive is encrypted in-place after compression (streamed
   * read → cipher → write of a sibling .tmp, then atomic rename over the
   * .tar.zst path). The on-disk filename does NOT change — callers pass
   * the same path to saveCache as before. Restore-side magic-byte sniff
   * detects the SOLDRENC frame and routes through decryptFile.
   *
   * Explicit `null` means "do not auto-load from env"; leaving it
   * `undefined` lets cacheKey + SETUP_SOLDR_CACHE_ENCRYPT_KEY produce
   * one automatically.
   */
  encryption?: EncryptionConfig | null;
  /**
   * Cache key for AAD derivation. Used only when `encryption` is left
   * undefined and the env-supplied key is present. Pass the same string
   * the caller will hand to actions/cache.
   */
  cacheKey?: string;
}): Promise<CompressResult> {
  const {
    cacheDir,
    codec,
    level,
    debug = false,
    log = (): void => undefined,
    longWindow,
    ultra,
    extraBasenames = [],
    payloadWarnBytes = null,
    payloadMaxBytes = null,
    payloadOversizeAction = "skip",
    payloadTopN,
    payloadProfile = "generic",
    label,
  } = opts;
  const encryption = resolveCacheEncryption({
    explicit: opts.encryption,
    cacheKey: opts.cacheKey,
  });
  const nullResult: CompressResult = {
    archivePath: null,
    archiveBytes: 0,
    inflatedBytes: null,
    fileCount: null,
    payload: null,
  };

  if (codec === "none") return nullResult;

  const zstdPath = await io.which("zstd", false);
  if (!zstdPath) {
    core.warning(
      "setup-soldr: zstd binary not found on PATH; falling back to actions/cache default codec",
    );
    return nullResult;
  }

  if (!(await pathExists(cacheDir))) {
    core.warning(`setup-soldr: cache dir ${cacheDir} does not exist, skipping compression`);
    return nullResult;
  }

  const parent = path.dirname(cacheDir);
  const basename = path.basename(cacheDir);
  // Filter sibling basenames to ones that actually exist under the parent —
  // tar errors on missing inputs, and cargo-registry's `.global-cache` /
  // `git/` may legitimately be absent on a cold checkout.
  const presentExtras: string[] = [];
  for (const extra of extraBasenames) {
    if (!extra || extra === basename) continue;
    if (await pathExists(path.join(parent, extra))) {
      presentExtras.push(extra);
    } else if (debug) {
      log(`[debug] compress: skipping missing sibling basename '${extra}' under ${parent}`);
    }
  }
  const displayLabel = label ?? basename;
  const tarInputs = [basename, ...presentExtras];
  let payload = await planTarPayload({
    parent,
    inputBasenames: tarInputs,
    topN: payloadTopN,
    profile: payloadProfile,
  });
  let payloadCensus = publicPayload(payload);
  let inflatedBytes: number | null = payload.bytes;
  let fileCount: number | null = payload.files;
  if (debug) {
    const skipped = payload.skipped.reduce((sum, entry) => sum + entry.count, 0);
    log(
      `[debug] compress ${displayLabel}: input=${fmtBytesDebug(payload.bytes)} ` +
        `files=${payload.files} symlinks=${payload.symlinks} dirs=${payload.directories} skipped=${skipped}`,
    );
    if (payload.topFiles.length > 0) {
      log(
        `[debug] compress ${displayLabel}: largest files ` +
          payload.topFiles.map((entry) => `${entry.path}=${fmtBytesDebug(entry.bytes)}`).join(", "),
      );
    }
    if (payload.skipped.length > 0) {
      log(
        `[debug] compress ${displayLabel}: skipped ` +
          payload.skipped.map((entry) => `${entry.reason}=${entry.count}`).join(", "),
      );
    }
  }

  if (payloadWarnBytes !== null && payloadWarnBytes > 0 && payload.bytes > payloadWarnBytes) {
    const largest = payload.topFiles
      .slice(0, 5)
      .map((entry) => `${entry.path} (${fmtBytesDebug(entry.bytes)})`)
      .join(", ");
    core.warning(
      `setup-soldr: ${displayLabel} cache payload is ${fmtBytesDebug(payload.bytes)} before compression ` +
        `(>${fmtBytesDebug(payloadWarnBytes)}). Largest files: ${largest || "none"}`,
    );
  }

  if (payloadMaxBytes !== null && payloadMaxBytes > 0 && payload.bytes > payloadMaxBytes) {
    const message =
      `setup-soldr: ${displayLabel} cache payload is ${fmtBytesDebug(payload.bytes)} before compression, ` +
      `exceeding cache-payload-max-bytes=${fmtBytesDebug(payloadMaxBytes)}`;
    if (payloadOversizeAction === "fail") {
      throw new Error(message);
    }
    core.warning(`${message}; skipping cache save`);
    return {
      archivePath: null,
      archiveBytes: 0,
      inflatedBytes,
      fileCount,
      payload: payloadCensus,
      skippedReason: "payload-too-large",
    };
  }

  const archivePath = `${cacheDir}.tar.zst`;
  // Best-effort cleanup of any previous archive.
  await fs.rm(archivePath, { force: true }).catch(() => undefined);

  const levelNumeric = parseLevel(level);
  const levelFlag = `-${levelNumeric}`;
  const longFlag = typeof longWindow === "number" ? [`--long=${longWindow}`] : [];
  const ultraFlag = ultra || levelNumeric >= 20 ? ["--ultra"] : [];

  const writeArchiveFromManifest = async (entries: readonly string[]): Promise<void> => {
    const manifestDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-tar-"));
    const manifestPath = path.join(manifestDir, "manifest.txt");
    try {
      await fs.writeFile(
        manifestPath,
        entries.map((entry) => `${entry}\n`).join(""),
        "utf8",
      );
      if (debug) {
        log(
          `[debug] compress cmd: tar -cf - -C ${parent} -T ${manifestPath} | ` +
            `zstd -T0 ${levelFlag}${longFlag.length ? ` --long=${longWindow}` : ""}` +
            `${ultraFlag.length ? " --ultra" : ""} -o ${archivePath}`,
        );
      }
      await runPipe(
        ["tar", ["-cf", "-", "-C", parent, "-T", manifestPath]],
        [zstdPath, ["-T0", levelFlag, ...longFlag, ...ultraFlag, "-o", archivePath]],
      );
    } finally {
      await fs.rm(manifestDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  try {
    await writeArchiveFromManifest(payload.manifestEntries);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${displayLabel}: tar failed after payload preflight (${message}); retrying once with a fresh scan`);
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    payload = await planTarPayload({
      parent,
      inputBasenames: tarInputs,
      topN: payloadTopN,
      profile: payloadProfile,
    });
    payloadCensus = publicPayload(payload);
    inflatedBytes = payload.bytes;
    fileCount = payload.files;
    if (debug) {
      log(
        `[debug] compress ${displayLabel}: retry input=${fmtBytesDebug(payload.bytes)} ` +
          `files=${payload.files} symlinks=${payload.symlinks} dirs=${payload.directories}`,
      );
    }
    await writeArchiveFromManifest(payload.manifestEntries);
  }

  let archiveBytes = 0;
  try { archiveBytes = (await fs.stat(archivePath)).size; } catch { /* archive may not exist */ }

  if (debug && inflatedBytes !== null && inflatedBytes > 0) {
    log(`[debug] compress result: archive=${fmtBytesDebug(archiveBytes)} ratio=${(archiveBytes / inflatedBytes).toFixed(2)}`);
  }

  // #387 Feature 1: AES-256-GCM encrypt-in-place. The on-disk filename is
  // preserved so callers don't need to know whether encryption was applied —
  // the restore path detects the SOLDRENC magic byte and routes accordingly.
  // The encrypt step is a separate stream-read+stream-write disk pass so it
  // adds ~archive_size / SSD_throughput to the post step (e.g. ~5 s for a
  // 1 GiB archive at 200 MB/s). Acceptable cost for an opt-in security
  // feature; bypassed entirely when `encryption` is null.
  if (encryption) {
    const encryptTmp = `${archivePath}.enc-tmp-${process.pid}-${Date.now()}`;
    try {
      await encryptFile(archivePath, encryptTmp, encryption);
      await fs.rm(archivePath, { force: true });
      await fs.rename(encryptTmp, archivePath);
    } catch (err) {
      await fs.rm(encryptTmp, { force: true }).catch(() => undefined);
      throw err;
    }
    let encryptedBytes = archiveBytes;
    try { encryptedBytes = (await fs.stat(archivePath)).size; } catch { /* keep estimate */ }
    if (debug) {
      log(
        `[debug] encrypt ${displayLabel}: AES-256-GCM, ` +
          `plaintext=${fmtBytesDebug(archiveBytes)} ciphertext=${fmtBytesDebug(encryptedBytes)}`,
      );
    }
    archiveBytes = encryptedBytes;
  }

  return { archivePath, archiveBytes, inflatedBytes, fileCount, payload: payloadCensus };
}

function parseLevel(value: string): number {
  const trimmed = (value ?? "").toString().trim();
  if (!trimmed) return 3;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return 3;
  const clamped = Math.max(1, Math.min(22, Math.floor(parsed)));
  return clamped;
}

/**
 * Run two processes piped together: producer.stdout -> consumer.stdin.
 * Bubbles non-zero exit codes from either side.
 */
async function runPipe(
  producer: [string, string[]],
  consumer: [string, string[]],
): Promise<void> {
  const { spawn } = await import("node:child_process");
  const [pCmd, pArgs] = producer;
  const [cCmd, cArgs] = consumer;
  await new Promise<void>((resolve, reject) => {
    const prod = spawn(pCmd, pArgs, { stdio: ["ignore", "pipe", "inherit"] });
    const cons = spawn(cCmd, cArgs, { stdio: ["pipe", "inherit", "inherit"] });
    prod.on("error", (err) => reject(err));
    cons.on("error", (err) => reject(err));
    if (prod.stdout && cons.stdin) {
      prod.stdout.pipe(cons.stdin);
    }
    let prodExit: number | null = null;
    let consExit: number | null = null;
    const maybeDone = (): void => {
      if (prodExit !== null && consExit !== null) {
        if (prodExit !== 0) {
          reject(new Error(`${pCmd} exited with code ${prodExit}`));
        } else if (consExit !== 0) {
          reject(new Error(`${cCmd} exited with code ${consExit}`));
        } else {
          resolve();
        }
      }
    };
    prod.on("close", (code) => {
      prodExit = code ?? 0;
      maybeDone();
    });
    cons.on("close", (code) => {
      consExit = code ?? 0;
      maybeDone();
    });
  });
}
