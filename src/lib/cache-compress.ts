// Tar+zstd cache compression helpers. Owned by Agent 2.
//
// Used by src/main.ts (restore: auto-detect .tar.zst, decompress in place)
// and src/post.ts (save: tar+zstd the cache dir).
//
// Acceptance criterion #1 + #2 of zackees/setup-soldr#70: post-job tar+zstd
// at level configured by target-cache-compress-level, restore auto-detects
// zstd vs gzip magic bytes for back-compat.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";

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

/**
 * Decompress <cache-dir>.tar.zst (or .tar.gz) into <cache-dir>.
 *
 *   zstd: `zstd -d <archive>` piped into `tar -xf - -C <targetDir>`.
 *   gzip: `tar -xzf <archive> -C <targetDir>`.
 */
export async function decompressCache(opts: { archivePath: string; targetDir: string }): Promise<void> {
  const { archivePath, targetDir } = opts;
  await ensureDir(targetDir);
  const magic = await detectCompressMagic(archivePath);
  if (magic === "gzip") {
    await exec.exec("tar", ["-xzf", archivePath, "-C", targetDir]);
    return;
  }
  if (magic === "zstd") {
    // tar -xf - reads from stdin; we pipe `zstd -d -c <archive>` into it.
    const zstdPath = await io.which("zstd", false);
    if (!zstdPath) {
      // Fall back: many tars know how to decode zstd themselves (--zstd).
      await exec.exec("tar", ["--zstd", "-xf", archivePath, "-C", targetDir]);
      return;
    }
    await runPipe(
      [zstdPath, ["-d", "-c", archivePath]],
      ["tar", ["-xf", "-", "-C", targetDir]],
    );
    return;
  }
  throw new Error(`decompressCache: unrecognized archive magic for ${archivePath}`);
}

/**
 * tar -cf - <cache-dir-basename> | zstd -T0 -<level> > <cache-dir>.tar.zst
 *
 * When codec=="none" or zstd is not installed, returns null and leaves the
 * caller to use the default actions/cache compression.
 */
export async function compressCache(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
}): Promise<string | null> {
  const { cacheDir, codec, level } = opts;
  if (codec === "none") return null;

  const zstdPath = await io.which("zstd", false);
  if (!zstdPath) {
    core.warning(
      "setup-soldr: zstd binary not found on PATH; falling back to actions/cache default codec",
    );
    return null;
  }

  if (!(await pathExists(cacheDir))) {
    core.warning(`setup-soldr: cache dir ${cacheDir} does not exist, skipping compression`);
    return null;
  }

  const parent = path.dirname(cacheDir);
  const basename = path.basename(cacheDir);
  const archivePath = `${cacheDir}.tar.zst`;
  // Best-effort cleanup of any previous archive.
  await fs.rm(archivePath, { force: true }).catch(() => undefined);

  const levelNumeric = parseLevel(level);
  const levelFlag = `-${levelNumeric}`;

  await runPipe(
    ["tar", ["-cf", "-", "-C", parent, basename]],
    [zstdPath, ["-T0", levelFlag, "-o", archivePath]],
  );

  return archivePath;
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
