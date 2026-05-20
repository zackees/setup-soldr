// Source-mtime snapshot + replay.
//
// Problem: `actions/checkout` rewrites every source file's mtime to "now"
// on every workflow run. Cargo's fingerprint files record source mtimes at
// compile time, so on warm runs Cargo sees `warm_checkout_time > cold_mtime`
// for every source file and reruns every rustc invocation — even when the
// content is byte-identical and the zccache compile-cache holds the answer.
//
// This module captures the mtimes Cargo *did* see on the cold side and
// replays them on the warm side, but only for files whose **content** is
// still byte-identical (size + sha256 prefix match). If a source file
// changed between cold and warm, its current mtime is preserved so Cargo
// rebuilds it correctly. That's the safety net `source-mtime-normalize`
// lacked — it set mtimes to "last commit time" unconditionally and could
// underbuild when a file was edited since the last commit.
//
// Format: small JSON sidecar written inside the build-cache directory so
// it rides along in the same tar.zst that ships zccache's artifacts. ~110
// bytes per file; a 1000-file project produces ~110KB raw, ~30KB after
// zstd. Drop the dependency on protobuf — at this scale the size and
// parse-time savings are negligible.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { selectCandidateFiles, listTrackedFiles, isGitRepo } from "./normalize-source-mtime.js";

export const SNAPSHOT_FILENAME = "setup-soldr-source-mtimes.json";

interface SnapshotEntry {
  /** mtime in integer milliseconds since the epoch, matching fs.Stats.mtimeMs. */
  mtime_ms: number;
  size: number;
  /** First 32 hex chars of the file's sha256. Cheap, ample collision margin. */
  hash: string;
}

export interface Snapshot {
  version: 1;
  /** Wall-clock time the snapshot was taken (sanity / debug). */
  snapshot_at_ms: number;
  /** Workspace path the snapshot was relative to. Sanity-checked on replay. */
  workspace: string;
  /** Repo-relative POSIX paths → entry. */
  files: Record<string, SnapshotEntry>;
}

export interface SnapshotResult {
  snapshot: Snapshot;
  scanned: number;
  hashed: number;
  skipped: number;
}

export interface ReplayResult {
  applied: number;
  skipped_missing: number;
  skipped_modified: number;
  skipped_size_mismatch: number;
  total: number;
}

async function hashFile(absolute: string): Promise<string> {
  // sha256 prefix (first 32 hex = 128 bits). Streaming so we don't load
  // multi-MB sources into memory all at once.
  return await new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const stream = fs.createReadStream(absolute);
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(h.digest("hex").slice(0, 32)));
  });
}

/**
 * Walk tracked source files and snapshot each file's (mtime, size,
 * content-hash). Returns the snapshot plus counters; the caller writes
 * the JSON wherever it wants to ship it (typically inside the build
 * cache directory so it ends up in the tar.zst archive).
 */
export async function snapshotSourceMtimes(opts: {
  workspace: string;
  log?: (msg: string) => void;
}): Promise<SnapshotResult> {
  const log = opts.log ?? ((): void => undefined);
  if (!(await isGitRepo(opts.workspace))) {
    log(`source-mtime-snapshot: ${opts.workspace} is not a git work tree, skipping`);
    return {
      snapshot: { version: 1, snapshot_at_ms: Date.now(), workspace: opts.workspace, files: {} },
      scanned: 0,
      hashed: 0,
      skipped: 0,
    };
  }
  const tracked = await listTrackedFiles(opts.workspace);
  const candidates = selectCandidateFiles(tracked);
  const files: Record<string, SnapshotEntry> = {};
  let hashed = 0;
  let skipped = 0;
  for (const rel of candidates) {
    const abs = path.join(opts.workspace, ...rel.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      skipped += 1;
      continue;
    }
    if (!stat.isFile()) {
      skipped += 1;
      continue;
    }
    let hash: string;
    try {
      hash = await hashFile(abs);
    } catch {
      skipped += 1;
      continue;
    }
    files[rel] = {
      mtime_ms: Math.floor(stat.mtimeMs),
      size: stat.size,
      hash,
    };
    hashed += 1;
  }
  return {
    snapshot: {
      version: 1,
      snapshot_at_ms: Date.now(),
      workspace: opts.workspace,
      files,
    },
    scanned: candidates.length,
    hashed,
    skipped,
  };
}

/**
 * Replay mtimes from a snapshot onto the current workspace. Safety net:
 * for each file we verify the current (size, content-hash) matches what
 * was captured at snapshot time. If it doesn't, we leave the current
 * mtime alone so Cargo correctly rebuilds whatever changed.
 */
export async function replaySourceMtimes(opts: {
  workspace: string;
  snapshot: Snapshot;
  log?: (msg: string) => void;
}): Promise<ReplayResult> {
  const log = opts.log ?? ((): void => undefined);
  const total = Object.keys(opts.snapshot.files).length;
  let applied = 0;
  let skippedMissing = 0;
  let skippedSize = 0;
  let skippedModified = 0;
  for (const [rel, entry] of Object.entries(opts.snapshot.files)) {
    const abs = path.join(opts.workspace, ...rel.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      skippedMissing += 1;
      continue;
    }
    if (!stat.isFile()) {
      skippedMissing += 1;
      continue;
    }
    if (stat.size !== entry.size) {
      skippedSize += 1;
      continue;
    }
    let hash: string;
    try {
      hash = await hashFile(abs);
    } catch {
      skippedModified += 1;
      continue;
    }
    if (hash !== entry.hash) {
      skippedModified += 1;
      continue;
    }
    const seconds = entry.mtime_ms / 1000;
    try {
      fs.utimesSync(abs, seconds, seconds);
      applied += 1;
    } catch (err) {
      log(
        `source-mtime-replay: utimes failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
      skippedModified += 1;
    }
  }
  return {
    applied,
    skipped_missing: skippedMissing,
    skipped_modified: skippedModified,
    skipped_size_mismatch: skippedSize,
    total,
  };
}

/** Write a snapshot to disk as compact JSON. */
export function writeSnapshotFile(snapshot: Snapshot, outPath: string): void {
  fs.writeFileSync(outPath, JSON.stringify(snapshot), "utf8");
}

/** Read a snapshot back; returns null if the file doesn't exist or parsing fails. */
export function readSnapshotFile(filePath: string): Snapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { files?: unknown }).files !== "object"
  ) {
    return null;
  }
  return parsed as Snapshot;
}
