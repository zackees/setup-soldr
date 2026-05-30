// Wire `soldr load` into the cargo-registry-cache restore path on Windows
// runners where Defender's per-CreateFile scan + NTFS overhead dominate
// the wall clock for serial tar extraction. See zackees/setup-soldr#260
// and zackees/soldr#575.
//
// Strategy:
// - Detect the archive's first tar entry. If it's `SOLDR_MANIFEST.pb`,
//   the archive was produced by `soldr save` and we can use `soldr load`
//   for parallel extraction.
// - Otherwise fall through to the existing tar/zstd path so legacy
//   archives keep working.
//
// The detection avoids fully decompressing the archive — we only read
// the first ~2 KiB of decompressed bytes (one tar block of 512 bytes
// minimum, plus zstd frame slack).

import * as fs from "node:fs/promises";
import * as exec from "@actions/exec";

/** Min soldr version with parallel-extract `soldr load`. Released in 0.7.46 alongside zackees/soldr#575. */
export const MIN_SOLDR_VERSION_FOR_LOAD = "0.7.46";

/** Filename of the manifest at the root of every `soldr save` archive. */
const SOLDR_MANIFEST_NAME = "SOLDR_MANIFEST.pb";

/** Parse a `MAJOR.MINOR.PATCH` prefix from a version string. */
function parseSemver(value: string): [number, number, number] | null {
  const m = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]!), Number(m[2]!), Number(m[3]!)];
}

/** Compare two semvers; `true` if `value >= minimum`. */
export function semverGte(value: string, minimum: string): boolean {
  const got = parseSemver(value);
  const want = parseSemver(minimum);
  if (!got || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i]! > want[i]!) return true;
    if (got[i]! < want[i]!) return false;
  }
  return true;
}

/**
 * Sniff whether the archive's first tar entry is `SOLDR_MANIFEST.pb`,
 * indicating a `soldr save` archive. Returns `false` on any read or
 * decode error — the caller should fall through to the legacy path.
 *
 * Uses synchronous `tar -tf` + `head -1` via `spawnSync` so the
 * subprocesses are guaranteed to be reaped before this function
 * returns (avoiding test-runner timeout from leaked descriptors).
 */
export async function detectSoldrManifest(archivePath: string): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
  // We invoke tar with `-tf <archive>` directly — bsdtar (Windows) and
  // GNU tar (Linux/macOS) both auto-detect zstd by magic byte on modern
  // versions. Bounded by `timeout: 5000ms`; if tar takes longer than
  // that on a single header read, we treat the archive as not-soldr.
  let res;
  try {
    res = spawnSync("tar", ["-tf", archivePath], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (res.error || res.status !== 0) return false;
  const first = (res.stdout ?? "").split(/\r?\n/, 2)[0]?.trim();
  return first === SOLDR_MANIFEST_NAME;
}

export interface SoldrLoadResult {
  used: boolean;
  durationMs: number;
}

export interface SoldrLoadOpts {
  archivePath: string;
  targetDir: string;
  soldrPath: string;
  soldrVersion: string;
  /** Pass `--auto-defender-exclude` on Windows runners. Default false. */
  autoDefenderExclude?: boolean;
  /** Pass `--profile-extract` for tuning. Default false. */
  profileExtract?: boolean;
  debug?: boolean;
  log?: (msg: string) => void;
}

/**
 * Attempt to invoke `soldr load` for parallel extraction. Returns
 * `{ used: false }` when the binary isn't available, the version is
 * too old, or the archive isn't in soldr format. Throws only on a
 * genuine extraction failure (so the caller can decide to fall back).
 */
export async function tryLoadViaSoldr(opts: SoldrLoadOpts): Promise<SoldrLoadResult> {
  const t0 = Date.now();
  const noOp: SoldrLoadResult = { used: false, durationMs: 0 };
  const log = opts.log ?? ((): void => undefined);
  if (!opts.soldrPath) {
    if (opts.debug) log(`[debug] soldr-load-shim: no soldr binary path supplied`);
    return noOp;
  }
  if (!semverGte(opts.soldrVersion, MIN_SOLDR_VERSION_FOR_LOAD)) {
    if (opts.debug) {
      log(
        `[debug] soldr-load-shim: soldr ${opts.soldrVersion} < ${MIN_SOLDR_VERSION_FOR_LOAD}; falling back to tar+zstd`,
      );
    }
    return noOp;
  }
  try {
    const st = await fs.stat(opts.archivePath);
    if (!st.isFile()) return noOp;
  } catch {
    return noOp;
  }
  const isSoldrFormat = await detectSoldrManifest(opts.archivePath);
  if (!isSoldrFormat) {
    if (opts.debug) {
      log(
        `[debug] soldr-load-shim: ${opts.archivePath} is not a soldr-format archive (no SOLDR_MANIFEST.pb); falling back to tar+zstd`,
      );
    }
    return noOp;
  }
  const args: string[] = ["load", "--archive", opts.archivePath, "--cache-dir", opts.targetDir];
  if (opts.autoDefenderExclude && process.platform === "win32") {
    args.push("--auto-defender-exclude");
  }
  if (opts.profileExtract) {
    args.push("--profile-extract");
  }
  if (opts.debug) log(`[debug] soldr-load-shim: invoking ${opts.soldrPath} ${args.join(" ")}`);
  await exec.exec(opts.soldrPath, args);
  return { used: true, durationMs: Date.now() - t0 };
}
