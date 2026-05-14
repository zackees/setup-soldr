// Tar+zstd cache compression helpers. Owned by Agent 2.
//
// Used by src/main.ts (restore: auto-detect .tar.zst, decompress in place)
// and src/post.ts (save: tar+zstd the cache dir).
//
// Acceptance criterion #1 + #2 of zackees/setup-soldr#70: post-job tar+zstd
// at level configured by target-cache-compress-level, restore auto-detects
// zstd vs gzip magic bytes for back-compat.

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";

/**
 * Recursively walk a directory and sum file sizes.
 * Returns { bytes, files } for all regular files found.
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
          const st = await fs.stat(full);
          bytes += st.size;
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

export interface DecompressResult {
  archiveBytes: number;
  inflatedBytes: number;
  fileCount: number;
}

/**
 * Decompress <cache-dir>.tar.zst (or .tar.gz) into <cache-dir>.
 *
 *   zstd: `zstd -d <archive>` piped into `tar -xf - -C <targetDir>`.
 *   gzip: `tar -xzf <archive> -C <targetDir>`.
 *
 * Returns compressed archive size, inflated directory size, and file count.
 * When debug=true, logs verbose byte/file diagnostics via the supplied log fn.
 */
export async function decompressCache(opts: {
  archivePath: string;
  targetDir: string;
  debug?: boolean;
  log?: (msg: string) => void;
}): Promise<DecompressResult> {
  const { archivePath, targetDir, debug = false, log = (): void => undefined } = opts;
  await ensureDir(targetDir);

  let archiveBytes = 0;
  try {
    archiveBytes = (await fs.stat(archivePath)).size;
  } catch {
    // archive may not exist — caller guards, but be safe
  }

  const magic = await detectCompressMagic(archivePath);
  if (debug) {
    log(`[debug] decompress ${path.basename(archivePath)}: magic=${magic} archive=${fmtBytesDebug(archiveBytes)}`);
  }

  if (magic === "gzip") {
    if (debug) log(`[debug] decompress cmd: tar -xzf ${archivePath} -C ${targetDir}`);
    await exec.exec("tar", ["-xzf", archivePath, "-C", targetDir]);
  } else if (magic === "zstd") {
    const zstdPath = await io.which("zstd", false);
    if (!zstdPath) {
      if (debug) log(`[debug] decompress cmd (zstd fallback): tar --zstd -xf ${archivePath} -C ${targetDir}`);
      // Fall back: many tars know how to decode zstd themselves (--zstd).
      await exec.exec("tar", ["--zstd", "-xf", archivePath, "-C", targetDir]);
    } else {
      if (debug) log(`[debug] decompress cmd: zstd -d -c ${archivePath} | tar -xf - -C ${targetDir}`);
      // tar -xf - reads from stdin; we pipe `zstd -d -c <archive>` into it.
      await runPipe(
        [zstdPath, ["-d", "-c", archivePath]],
        ["tar", ["-xf", "-", "-C", targetDir]],
      );
    }
  } else {
    throw new Error(`decompressCache: unrecognized archive magic for ${archivePath}`);
  }

  const { bytes: inflatedBytes, files: fileCount } = await walkDirSize(targetDir);
  if (debug) {
    const ratio = archiveBytes > 0 ? (archiveBytes / inflatedBytes).toFixed(2) : "n/a";
    log(`[debug] decompress result: inflated=${fmtBytesDebug(inflatedBytes)} files=${fileCount} ratio=${ratio}`);
  }

  return { archiveBytes, inflatedBytes, fileCount };
}

export interface CompressResult {
  archivePath: string | null;
  archiveBytes: number;
  inflatedBytes: number | null;
  fileCount: number | null;
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
}): Promise<CompressResult> {
  const { cacheDir, codec, level, debug = false, log = (): void => undefined } = opts;
  const nullResult: CompressResult = { archivePath: null, archiveBytes: 0, inflatedBytes: null, fileCount: null };

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

  let inflatedBytes: number | null = null;
  let fileCount: number | null = null;
  if (debug) {
    const walked = await walkDirSize(cacheDir);
    inflatedBytes = walked.bytes;
    fileCount = walked.files;
    log(`[debug] compress ${path.basename(cacheDir)}: input=${fmtBytesDebug(inflatedBytes)} files=${fileCount}`);
  }

  const parent = path.dirname(cacheDir);
  const basename = path.basename(cacheDir);
  const archivePath = `${cacheDir}.tar.zst`;
  // Best-effort cleanup of any previous archive.
  await fs.rm(archivePath, { force: true }).catch(() => undefined);

  const levelNumeric = parseLevel(level);
  const levelFlag = `-${levelNumeric}`;

  if (debug) log(`[debug] compress cmd: tar -cf - -C ${parent} ${basename} | zstd -T0 ${levelFlag} -o ${archivePath}`);
  await runPipe(
    ["tar", ["-cf", "-", "-C", parent, basename]],
    [zstdPath, ["-T0", levelFlag, "-o", archivePath]],
  );

  let archiveBytes = 0;
  try {
    archiveBytes = (await fs.stat(archivePath)).size;
  } catch {
    // archive may not have been created
  }

  if (debug && inflatedBytes !== null && inflatedBytes > 0) {
    const ratio = (archiveBytes / inflatedBytes).toFixed(2);
    log(`[debug] compress result: archive=${fmtBytesDebug(archiveBytes)} ratio=${ratio}`);
  }

  return { archivePath, archiveBytes, inflatedBytes, fileCount };
}

function fmtBytesDebug(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
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
