// Seed an isolated SOLDR_CACHE_DIR from the restored build-cache (issue #240).
//
// zccache's daemon-isolation contract (zccache#430/#421) lets a self-test
// phase (coverage/integration) run under a FRESH SOLDR_CACHE_DIR so the
// builder daemon never leaks into the tests. The side effect is that the warm
// build-cache setup-soldr restored is discarded, so the isolated phase
// recompiles from scratch every run.
//
// This seeds the fresh dir with ONLY the content-addressed artifact store from
// the restored build-cache — exactly the file classes the build-cache save
// profile keeps (#229), and nothing live: no logs, no sockets/pidfiles, no
// lock/temp files. Content-addressed artifacts are safe to share read-only
// across the isolation boundary; live daemon state is not copied, so the
// isolated daemon stays its own session.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  BUILD_CACHE_DENIED_DIAGNOSTIC_SUFFIXES,
  isZccacheArtifactPayloadPath,
} from "./cache-compress.js";

const TRANSIENT_SEED_SUFFIXES = [".lock", ".lck", ".sock", ".pid", ".tmp", ".temp", ".part", ".partial"];

export interface SeedIsolatedResult {
  seeded: boolean;
  filesCopied: number;
  bytesCopied: number;
  destinations: string[];
  skippedReason?: string;
}

/** Parse the `seed-isolated-build-cache` input into isolated SOLDR_CACHE_DIR roots. */
export function parseIsolatedSeedTargets(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Decide whether a file inside the zccache store should be seeded into an
 * isolated copy. Keeps the reusable content-addressed store; drops the
 * `logs/` subtree, standalone diagnostic sidecars (outside artifacts dirs),
 * and transient daemon files (sockets/locks/pidfiles/temp). `tarPath` is the
 * path relative to the zccache parent using "/" separators (e.g.
 * `zccache/artifacts/<hash>`).
 */
export function shouldSeedBuildCacheEntry(tarPath: string): boolean {
  const parts = tarPath.split("/").map((p) => p.toLowerCase());
  if (parts.includes("logs")) return false;
  const basename = parts[parts.length - 1] ?? "";
  if (TRANSIENT_SEED_SUFFIXES.some((s) => basename.endsWith(s))) return false;
  // Diagnostic sidecars are dropped unless they live inside an artifacts dir,
  // where they are compiler stdout/stderr replay metadata (see #229).
  if (
    !isZccacheArtifactPayloadPath(tarPath) &&
    BUILD_CACHE_DENIED_DIAGNOSTIC_SUFFIXES.some((s) => basename.endsWith(s))
  ) {
    return false;
  }
  return true;
}

function copyTreeFiltered(
  srcRoot: string,
  destZccacheDir: string,
  relPrefix: string,
): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (relDir: string): void => {
    const absDir = path.join(srcRoot, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const tarPath = `${relPrefix}/${rel}`;
      if (ent.isDirectory()) {
        walk(rel);
        continue;
      }
      // Only regular files are seeded — sockets/fifos/symlinks are skipped.
      if (!ent.isFile()) continue;
      if (!shouldSeedBuildCacheEntry(tarPath)) continue;
      const srcFile = path.join(srcRoot, rel);
      const destFile = path.join(destZccacheDir, rel);
      try {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(srcFile, destFile);
        files += 1;
        bytes += fs.statSync(destFile).size;
      } catch {
        // Best-effort: a single uncopyable file must not abort the seed.
      }
    }
  };
  walk("");
  return { files, bytes };
}

/**
 * Copy the reusable artifact store from a restored build-cache zccache dir
 * into one or more isolated SOLDR_CACHE_DIR roots. Best-effort: returns a
 * result, never throws. The destination zccache store lives at
 * `<root>/cache/zccache`, mirroring resolve-setup's derivation.
 */
export function seedIsolatedBuildCache(opts: {
  sourceZccacheDir: string;
  targetSoldrRoots: string[];
  log?: (m: string) => void;
}): SeedIsolatedResult {
  const log = opts.log ?? (() => {});
  const destinations: string[] = [];
  if (opts.targetSoldrRoots.length === 0) {
    return { seeded: false, filesCopied: 0, bytesCopied: 0, destinations, skippedReason: "no-targets" };
  }
  let sourceIsDir = false;
  try {
    sourceIsDir = fs.statSync(opts.sourceZccacheDir).isDirectory();
  } catch {
    sourceIsDir = false;
  }
  if (!sourceIsDir) {
    log(`seed-isolated-build-cache: source zccache dir ${opts.sourceZccacheDir} not present — nothing to seed`);
    return { seeded: false, filesCopied: 0, bytesCopied: 0, destinations, skippedReason: "no-source" };
  }

  let totalFiles = 0;
  let totalBytes = 0;
  // The store is rooted at a directory named "zccache" so tar paths read
  // `zccache/...` and match the #229 contract predicates.
  const relPrefix = path.basename(opts.sourceZccacheDir) || "zccache";
  for (const root of opts.targetSoldrRoots) {
    const destZccacheDir = path.join(root, "cache", "zccache");
    if (path.resolve(destZccacheDir) === path.resolve(opts.sourceZccacheDir)) {
      log(`seed-isolated-build-cache: target ${root} resolves to the source store — skipping self-seed`);
      continue;
    }
    const { files, bytes } = copyTreeFiltered(opts.sourceZccacheDir, destZccacheDir, relPrefix);
    totalFiles += files;
    totalBytes += bytes;
    destinations.push(destZccacheDir);
    log(`seed-isolated-build-cache: seeded ${files} artifact file(s) (${bytes} bytes) → ${destZccacheDir}`);
  }
  return {
    seeded: totalFiles > 0,
    filesCopied: totalFiles,
    bytesCopied: totalBytes,
    destinations,
  };
}
