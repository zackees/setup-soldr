// Post-job entry point. Tars the configured cache directory and pipes the
// stream through `zstd -T0 -<level>` to produce <cache-dir>.tar.zst. The
// next-registered actions/cache@v5 step's post-save then uploads the file.
//
// If codec is "none", emit an uncompressed .tar (still under the .tar.zst
// name for path stability) - actions/cache picks up whatever exists at the
// configured `path:`. If the cache directory doesn't exist, this is a no-op
// and we leave any pre-existing archive untouched.

"use strict";

const core = require("@actions/core");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function clampLevel(rawLevel) {
  const parsed = parseInt(String(rawLevel).trim(), 10);
  if (Number.isNaN(parsed)) {
    return 3;
  }
  if (parsed < 1) {
    return 1;
  }
  if (parsed > 22) {
    return 22;
  }
  return parsed;
}

function tarBaseAndDir(cacheDir) {
  const resolved = path.resolve(cacheDir);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  return { parent, base };
}

async function archiveWithZstd(cacheDir, archivePath, level) {
  const { parent, base } = tarBaseAndDir(cacheDir);
  const tar = spawn("tar", ["-cf", "-", "-C", parent, base], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const out = fs.createWriteStream(archivePath);
  const zstd = spawn("zstd", ["-T0", `-${level}`, "-q"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  tar.stdout.pipe(zstd.stdin);
  zstd.stdout.pipe(out);

  await new Promise((resolve, reject) => {
    let tarExit = null;
    let zstdExit = null;
    let outDone = false;
    function finish() {
      if (tarExit === null || zstdExit === null || !outDone) {
        return;
      }
      if (tarExit !== 0) {
        reject(new Error(`tar -cf - exited with code ${tarExit}`));
        return;
      }
      if (zstdExit !== 0) {
        reject(new Error(`zstd exited with code ${zstdExit}`));
        return;
      }
      resolve(undefined);
    }
    tar.on("close", (code) => {
      tarExit = code === null ? 1 : code;
      finish();
    });
    zstd.on("close", (code) => {
      zstdExit = code === null ? 1 : code;
      finish();
    });
    out.on("close", () => {
      outDone = true;
      finish();
    });
    tar.on("error", reject);
    zstd.on("error", reject);
    out.on("error", reject);
  });
}

async function archiveWithoutCompression(cacheDir, archivePath) {
  const { parent, base } = tarBaseAndDir(cacheDir);
  const tar = spawn("tar", ["-cf", archivePath, "-C", parent, base], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  await new Promise((resolve, reject) => {
    tar.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`tar -cf exited with code ${code === null ? 1 : code}`));
      }
    });
    tar.on("error", reject);
  });
}

async function run() {
  const cacheDir =
    core.getState("cache-dir") || core.getInput("cache-dir") || "";
  const codec = (
    core.getState("codec") ||
    core.getInput("codec") ||
    "zstd"
  )
    .trim()
    .toLowerCase();
  const levelInput = core.getState("level") || core.getInput("level") || "3";
  const level = clampLevel(levelInput);

  if (!cacheDir) {
    core.warning(
      "setup-soldr-cache-compress (post): no cache-dir state recorded; skipping archive.",
    );
    return;
  }
  if (!fs.existsSync(cacheDir)) {
    core.info(
      `setup-soldr-cache-compress (post): cache-dir ${cacheDir} does not exist; skipping archive.`,
    );
    return;
  }
  let stat;
  try {
    stat = fs.statSync(cacheDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `setup-soldr-cache-compress (post): failed to stat ${cacheDir}: ${message}; skipping archive.`,
    );
    return;
  }
  if (!stat.isDirectory()) {
    core.warning(
      `setup-soldr-cache-compress (post): ${cacheDir} is not a directory; skipping archive.`,
    );
    return;
  }

  const archivePath = `${cacheDir}.tar.zst`;
  // Remove any stale archive so we never accidentally upload an outdated payload.
  try {
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `setup-soldr-cache-compress (post): could not remove stale ${archivePath}: ${message}`,
    );
  }

  try {
    if (codec === "none") {
      core.info(
        `setup-soldr-cache-compress (post): tarring ${cacheDir} -> ${archivePath} (codec=none)`,
      );
      await archiveWithoutCompression(cacheDir, archivePath);
    } else {
      core.info(
        `setup-soldr-cache-compress (post): tar | zstd -T0 -${level} ${cacheDir} -> ${archivePath}`,
      );
      await archiveWithZstd(cacheDir, archivePath, level);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(
      `setup-soldr-cache-compress (post): failed to archive ${cacheDir}: ${message}`,
    );
  }
}

module.exports = {
  clampLevel,
  tarBaseAndDir,
  archiveWithZstd,
  archiveWithoutCompression,
  run,
};

if (require.main === module) {
  run().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(
      `setup-soldr-cache-compress (post): unhandled error: ${message}`,
    );
  });
}
