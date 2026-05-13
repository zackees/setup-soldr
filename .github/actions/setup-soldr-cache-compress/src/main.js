// Restore-side entry point. Looks for <cache-dir>.tar.zst (or .tar.gz for
// legacy entries) next to the configured cache directory and decompresses it
// in place using the system zstd/tar binaries. Also registers the post-job
// hook by virtue of being a Node action with a post: entry in action.yml.
//
// Auto-detect strategy:
//   - 0x28 B5 2F FD -> zstd magic: `zstd -d | tar -xf - -C <parent>`
//   - 0x1F 8B       -> gzip magic: `tar -xzf <file> -C <parent>`
//   - other / missing -> no-op (legacy directory-shaped restore handled it
//     already, or cache miss)

"use strict";

const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const path = require("path");

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function detectArchiveCodec(filePath) {
  // Returns "zstd", "gzip", or "unknown". Caller treats "unknown" as no-op.
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return "missing";
    }
    throw err;
  }
  try {
    const head = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, head, 0, 4, 0);
    if (bytesRead >= 4 && head.equals(ZSTD_MAGIC)) {
      return "zstd";
    }
    if (bytesRead >= 2 && head.slice(0, 2).equals(GZIP_MAGIC)) {
      return "gzip";
    }
    return "unknown";
  } finally {
    fs.closeSync(fd);
  }
}

async function decompressZstd(archivePath, parentDir) {
  // `zstd -d --stdout <file> | tar -xf - -C <parent>`. Using two execs and
  // piping via Node's child_process keeps the implementation portable without
  // depending on shell quoting rules.
  const { spawn } = require("child_process");
  await new Promise((resolve, reject) => {
    const zstd = spawn("zstd", ["-d", "--stdout", archivePath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const tar = spawn("tar", ["-xf", "-", "-C", parentDir], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    zstd.stdout.pipe(tar.stdin);
    let zstdExit = null;
    let tarExit = null;
    function finish() {
      if (zstdExit === null || tarExit === null) {
        return;
      }
      if (zstdExit !== 0) {
        reject(new Error(`zstd -d exited with code ${zstdExit}`));
        return;
      }
      if (tarExit !== 0) {
        reject(new Error(`tar -xf exited with code ${tarExit}`));
        return;
      }
      resolve(undefined);
    }
    zstd.on("close", (code) => {
      zstdExit = code === null ? 1 : code;
      finish();
    });
    tar.on("close", (code) => {
      tarExit = code === null ? 1 : code;
      finish();
    });
    zstd.on("error", reject);
    tar.on("error", reject);
  });
}

async function decompressGzip(archivePath, parentDir) {
  await exec.exec("tar", ["-xzf", archivePath, "-C", parentDir]);
}

async function run() {
  const cacheDir = core.getInput("cache-dir", { required: true });
  const codec = (core.getInput("codec") || "zstd").trim().toLowerCase();
  const level = (core.getInput("level") || "3").trim();

  // Persist for the post-job hook regardless of restore outcome.
  core.saveState("cache-dir", cacheDir);
  core.saveState("codec", codec);
  core.saveState("level", level);

  const archivePath = `${cacheDir}.tar.zst`;
  const parentDir = path.dirname(cacheDir) || ".";

  const detected = detectArchiveCodec(archivePath);
  if (detected === "missing") {
    core.info(
      `setup-soldr-cache-compress: no archive at ${archivePath}; nothing to restore.`,
    );
    return;
  }
  if (detected === "unknown") {
    core.warning(
      `setup-soldr-cache-compress: ${archivePath} exists but is neither zstd nor gzip; leaving untouched.`,
    );
    return;
  }

  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  try {
    if (detected === "zstd") {
      core.info(
        `setup-soldr-cache-compress: decompressing zstd archive ${archivePath} into ${parentDir}`,
      );
      await decompressZstd(archivePath, parentDir);
    } else {
      core.info(
        `setup-soldr-cache-compress: decompressing legacy gzip archive ${archivePath} into ${parentDir}`,
      );
      await decompressGzip(archivePath, parentDir);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    core.setFailed(
      `setup-soldr-cache-compress: failed to decompress ${archivePath}: ${message}`,
    );
  }
}

module.exports = {
  detectArchiveCodec,
  decompressZstd,
  decompressGzip,
  run,
  ZSTD_MAGIC,
  GZIP_MAGIC,
};

if (require.main === module) {
  run().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`setup-soldr-cache-compress: unhandled error: ${message}`);
  });
}
