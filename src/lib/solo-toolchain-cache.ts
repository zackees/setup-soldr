// Toolchain "solo" cache — long-lived, small, per-platform cache holding
// exactly one sealed rustup toolchain directory
// (`$RUSTUP_HOME/toolchains/<release>-<host>`) plus the rustup proxies in
// `$CARGO_HOME/bin/` that setup-soldr installed for it.
//
// Foundation layer per CLAUDE.md "Cache-lifetime axis: build the
// foundation first". Wraps `@actions/cache` with a staging-dir-based
// save and a verify-after-restore step (so a corrupt cache entry is
// treated as a miss rather than booby-trapping the run).
//
// #525: the toolchain is sealed (copied into the staging dir) at install
// time, before any job step runs, so later in-place writes such as
// `rustup target add` can never leak into the archive (#507). setup-soldr
// already knows the exact directory it installs, so there are no
// snapshot scans of `$RUSTUP_HOME/toolchains/` at all: "did the directory
// exist before the install" (one stat, see `soloPathExists`) replaces
// the old scan-and-diff. The key carries no soldr version, because the
// rustc bytes do not depend on it; format changes bump
// `SOLO_CACHE_SCHEMA_VERSION` instead (#328).
//
// Opt-in via the `solo-toolchain-cache` input. With the input off, none
// of this module's filesystem or cache-API paths run.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import { compressCache, decompressCache, detectCompressMagic } from "./cache-compress.js";

/** Staging-layout directory holding the sealed `toolchains/<dir>` tree. */
const STAGED_TOOLCHAINS = "rustup-toolchains";
/** Staging-layout directory holding the rustup proxies from `$CARGO_HOME/bin`. */
const STAGED_CARGO_BIN = "cargo-bin";
/** Staging-layout directory holding `$RUSTUP_HOME/update-hashes/<dir>`. */
const STAGED_UPDATE_HASHES = "rustup-update-hashes";
/**
 * Restore-side extraction root, created inside RUSTUP_HOME so the sealed
 * toolchain directory is renamed into `toolchains/` on the same
 * filesystem. Extracting under RUNNER_TEMP instead forces a per-file copy
 * in job containers, where RUNNER_TEMP is a bind mount and RUSTUP_HOME
 * lives in the image (EXDEV, ~1.5s for a ~580 MB toolchain; #525 E2).
 * Removed after every restore attempt.
 */
export const SOLO_RESTORE_EXTRACT_DIR = ".setup-soldr-solo-restore";

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

export interface SoloCacheKeyParts {
  runnerOs: string;
  runnerArch: string;
  libc: string;
  rustcRelease: string;
  componentsHash: string;
  targetsHash: string;
  /**
   * Test-only key namespace (see `soloKeyNamespaceFromEnv`). Empty or
   * absent for every real consumer.
   */
  namespace?: string;
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

export interface SoloCacheEntryRef {
  id: number;
  key: string;
  ref: string;
}

export interface DeleteCorruptSoloCacheResult {
  found: number;
  deleted: number;
  failed: number;
}

/** Prove an exact cache key exists on one ref; unlike restoreCache, this retains ref identity. */
export async function soloCacheEntryExistsForRef(opts: {
  owner: string;
  repo: string;
  token: string;
  key: string;
  ref: string;
  log: (msg: string) => void;
  listCaches?: () => Promise<SoloCacheEntryRef[]>;
}): Promise<boolean> {
  const { owner, repo, token, key, ref, log } = opts;
  if (!owner || !repo || !token || !key || !ref) return false;
  try {
    let entries: SoloCacheEntryRef[];
    if (opts.listCaches) {
      entries = await opts.listCaches();
    } else {
      const octokit = github.getOctokit(token);
      entries = [];
      let page = 1;
      while (true) {
        const response = await octokit.rest.actions.getActionsCacheList({
          owner, repo, key, ref, per_page: 100, page,
        });
        const items = response.data.actions_caches ?? [];
        for (const item of items) {
          if (item.id != null && item.key != null && item.ref != null) {
            entries.push({ id: item.id, key: item.key, ref: item.ref });
          }
        }
        if (items.length < 100) break;
        page += 1;
      }
    }
    return entries.some((entry) => entry.key === key && entry.ref === ref);
  } catch (err) {
    log(`solo-toolchain-cache: failed to prove replacement key=${key} ref=${ref}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Delete immutable poisoned entries before uploading a verified repair. */
export async function deleteCorruptSoloCacheEntries(opts: {
  owner: string;
  repo: string;
  token: string;
  key: string;
  ref: string;
  log: (msg: string) => void;
  listCaches?: () => Promise<SoloCacheEntryRef[]>;
  deleteCacheById?: (id: number) => Promise<void>;
}): Promise<DeleteCorruptSoloCacheResult> {
  const { owner, repo, token, key, ref, log } = opts;
  if (!owner || !repo || !token || !key || !ref) {
    log("solo-toolchain-cache: cannot delete corrupt entry: repository, token, key, or ref is missing");
    return { found: 0, deleted: 0, failed: 1 };
  }
  const octokit = github.getOctokit(token);
  const listCaches = opts.listCaches ?? (async (): Promise<SoloCacheEntryRef[]> => {
    const entries: SoloCacheEntryRef[] = [];
    let page = 1;
    while (true) {
      const response = await octokit.rest.actions.getActionsCacheList({
        owner,
        repo,
        key,
        ref,
        per_page: 100,
        page,
      });
      const items = response.data.actions_caches ?? [];
      for (const item of items) {
        if (item.id != null && item.key != null && item.ref != null) {
          entries.push({ id: item.id, key: item.key, ref: item.ref });
        }
      }
      if (items.length < 100) break;
      page += 1;
    }
    return entries;
  });
  const deleteCacheById = opts.deleteCacheById ?? (async (id: number): Promise<void> => {
    await octokit.rest.actions.deleteActionsCacheById({ owner, repo, cache_id: id });
  });
  let entries: SoloCacheEntryRef[];
  try {
    entries = (await listCaches()).filter((entry) => entry.key === key && entry.ref === ref);
  } catch (err) {
    log(`solo-toolchain-cache: failed to list corrupt entry key=${key} ref=${ref}: ${err instanceof Error ? err.message : String(err)}`);
    return { found: 0, deleted: 0, failed: 1 };
  }
  let deleted = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      await deleteCacheById(entry.id);
      deleted += 1;
      log(`solo-toolchain-cache: deleted corrupt entry id=${entry.id} key=${key} ref=${ref}`);
    } catch (err) {
      failed += 1;
      log(`solo-toolchain-cache: failed to delete corrupt entry id=${entry.id} key=${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { found: entries.length, deleted, failed };
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
// v3 (#473) stages repaired `changed` files as well as newly `added` files,
// invalidating the incomplete v2 entries that could contain only six files.
// v4 (#525) whole-toolchain sealed archive, key drops the soldr version.
export const SOLO_CACHE_SCHEMA_VERSION = 4;

/**
 * Test-only knob: a namespace folded into every solo key so that the
 * end-to-end probe (`.github/workflows/solo-toolchain-probe.yml`) can
 * write run-scoped entries and delete them afterwards (#513). Consumers
 * never set it; an unset or blank value leaves the key shape unchanged.
 */
export const SOLO_KEY_NAMESPACE_ENV = "SETUP_SOLDR_SOLO_TOOLCHAIN_KEY_NAMESPACE";

function sanitizeKeyNamespace(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Read the test-only key namespace from `SOLO_KEY_NAMESPACE_ENV`. Every
 * character outside `[A-Za-z0-9._-]` becomes `_`; blank → "".
 */
export function soloKeyNamespaceFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return sanitizeKeyNamespace(env[SOLO_KEY_NAMESPACE_ENV] ?? "");
}

export function buildSoloCacheKeys(parts: SoloCacheKeyParts): SoloCacheKeys {
  const release = parts.rustcRelease.trim() || "unresolved";
  const ns = sanitizeKeyNamespace(parts.namespace ?? "");
  // The namespace lives in the base so every fallback prefix stays
  // scoped to it; a probe run can never restore a consumer's entry.
  const base =
    `solo-toolchain-v${SOLO_CACHE_SCHEMA_VERSION}-` +
    (ns ? `ns${ns}-` : "") +
    `${parts.runnerOs}-${parts.runnerArch}-${parts.libc}-rustc${release}`;
  const exact = `${base}-c${parts.componentsHash}-t${parts.targetsHash}`;
  return {
    exact,
    fallbacks: [
      // 1) drop targets, 2) also drop components. Never os/arch/libc/release.
      `${base}-c${parts.componentsHash}-t`,
      `${base}-c`,
    ],
  };
}

/**
 * Map a runner platform/arch/libc to the rustup host triple, i.e. the
 * suffix rustup appends to toolchain directory names. Accepts both
 * Node (`linux`/`darwin`/`win32`, `x64`/`arm64`) and GitHub runner
 * (`Linux`/`macOS`/`Windows`, `X64`/`ARM64`) spellings. Returns null for
 * anything else so callers can disable the cache instead of guessing.
 */
export function rustHostTriple(platform: string, arch: string, libc: string): string | null {
  const p = platform.trim().toLowerCase();
  const a = arch.trim().toLowerCase();
  let cpu: string;
  if (a === "x64" || a === "amd64") cpu = "x86_64";
  else if (a === "arm64" || a === "aarch64") cpu = "aarch64";
  else return null;
  if (p === "linux") {
    return `${cpu}-unknown-linux-${libc.trim().toLowerCase() === "musl" ? "musl" : "gnu"}`;
  }
  if (p === "darwin" || p === "macos") return `${cpu}-apple-darwin`;
  if (p === "win32" || p === "windows") return `${cpu}-pc-windows-msvc`;
  return null;
}

/**
 * rustup stores toolchains as `<spec>-<host>` (see
 * `fsInstalledToolchains` in `./toolchain.ts`). A channel that already
 * names this host (`stable-x86_64-unknown-linux-gnu`) is its own directory
 * name; rustup does not append the host twice.
 */
export function toolchainDirName(channel: string, hostTriple: string): string {
  const spec = channel.trim();
  if (spec.endsWith(`-${hostTriple}`)) return spec;
  return `${spec}-${hostTriple}`;
}

/**
 * Injectable filesystem seam. Every filesystem access in the seal,
 * apply and restore paths goes through one of these so tests can count
 * and scope calls (#525 T1/T8).
 */
export interface SoloFs {
  stat(p: string): Promise<fs.Stats>;
  lstat(p: string): Promise<fs.Stats>;
  /** `readdir` with `withFileTypes: true`. */
  readdir(p: string): Promise<fs.Dirent[]>;
  /** utf8 read. */
  readFile(p: string): Promise<string>;
  readlink(p: string): Promise<string>;
  /** Recursive mkdir. */
  mkdir(p: string): Promise<void>;
  /**
   * Byte copy. Uses a reflink when the filesystem supports it and a real
   * copy otherwise; never a hardlink, so later in-place writes to the
   * source cannot reach the copy.
   */
  copyFile(src: string, dst: string): Promise<void>;
  symlink(target: string, p: string): Promise<void>;
  link(src: string, dst: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  /** Recursive, force (missing paths are not an error). */
  rm(p: string): Promise<void>;
}

export const defaultSoloFs: SoloFs = {
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  readFile: (p) => fsp.readFile(p, "utf8"),
  readlink: (p) => fsp.readlink(p),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true });
  },
  copyFile: (src, dst) => fsp.copyFile(src, dst, fs.constants.COPYFILE_FICLONE),
  symlink: (target, p) => fsp.symlink(target, p),
  link: (src, dst) => fsp.link(src, dst),
  rename: (src, dst) => fsp.rename(src, dst),
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
};

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Exactly one `stat`. Missing (ENOENT/ENOTDIR) → false; any other error
 * is rethrown so callers never mistake an unreadable path for an absent
 * one.
 */
export async function soloPathExists(p: string, sfs: SoloFs = defaultSoloFs): Promise<boolean> {
  try {
    await sfs.stat(p);
    return true;
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/** One `lstat`: true when anything (including a dangling symlink) is at `p`. */
async function soloEntryPresent(p: string, sfs: SoloFs): Promise<boolean> {
  try {
    await sfs.lstat(p);
    return true;
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await fn(item);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
}

const SEAL_COPY_CONCURRENCY = 16;

export interface SealToolchainOptions {
  rustupHome: string;
  cargoHome: string;
  /** `<release>-<host>` directory name under `<rustupHome>/toolchains/`. */
  toolchainDir: string;
  /** Proxy basenames under `<cargoHome>/bin/` to include when present. */
  proxies: string[];
  /** Also seal `<rustupHome>/update-hashes/<toolchainDir>` when present. */
  includeUpdateHash: boolean;
  /**
   * Staging directory, wiped first. Callers pass
   * `<runnerTemp>/setup-soldr-solo-cache/staged`: restore extracts into
   * `<dir>/staged`, and the tar top-level dir must match (#316/#326).
   */
  stagingDir: string;
  fs?: SoloFs;
}

export interface SealToolchainResult {
  /** Regular files copied from the toolchain directory. */
  files: number;
  /** Symlinks recreated from the toolchain directory. */
  symlinks: number;
  /** Directories created for the toolchain tree, including its root. */
  directories: number;
  /** Bytes of the regular files counted in `files`. */
  bytes: number;
  /** Proxies staged from `<cargoHome>/bin`. */
  proxies: number;
  /** True when the rustup update-hash file was staged. */
  updateHash: boolean;
}

/**
 * #525/#507: seal the freshly installed toolchain into `stagingDir` at
 * install time. Walks ONLY `<rustupHome>/toolchains/<toolchainDir>`
 * (never another toolchain, never following symlinks) and COPIES every
 * file, so later job steps writing into the live toolchain (for example
 * `rustup target add`) cannot change what is uploaded.
 *
 * Layout: `<stagingDir>/rustup-toolchains/<toolchainDir>/...`,
 * `<stagingDir>/cargo-bin/<proxy>`,
 * `<stagingDir>/rustup-update-hashes/<toolchainDir>`.
 */
export async function sealToolchainForSave(opts: SealToolchainOptions): Promise<SealToolchainResult> {
  const sfs = opts.fs ?? defaultSoloFs;
  const { rustupHome, cargoHome, toolchainDir, stagingDir } = opts;
  const srcRoot = path.join(rustupHome, "toolchains", toolchainDir);
  // Wipe first so a failed seal can never leave a previous run's staged
  // tree behind for the uploader.
  await sfs.rm(stagingDir);
  let rootStat: fs.Stats;
  try {
    rootStat = await sfs.stat(srcRoot);
  } catch (err) {
    throw new Error(
      `solo-toolchain-cache: toolchain dir missing: ${srcRoot} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`solo-toolchain-cache: toolchain path is not a directory: ${srcRoot}`);
  }

  const result: SealToolchainResult = {
    files: 0,
    symlinks: 0,
    directories: 0,
    bytes: 0,
    proxies: 0,
    updateHash: false,
  };
  const dstRoot = path.join(stagingDir, STAGED_TOOLCHAINS, toolchainDir);
  await sfs.mkdir(dstRoot);
  result.directories += 1;

  // Iterative walk mirroring the dirent handling of the removed
  // toolchain-snapshot walker: readdir withFileTypes, never follow
  // symlinks (they are recreated verbatim from readlink).
  const stack: { src: string; dst: string }[] = [{ src: srcRoot, dst: dstRoot }];
  while (stack.length > 0) {
    const frame = stack.pop() as { src: string; dst: string };
    const dirents = await sfs.readdir(frame.src);
    const leaves: fs.Dirent[] = [];
    for (const dirent of dirents) {
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        const child = { src: path.join(frame.src, dirent.name), dst: path.join(frame.dst, dirent.name) };
        await sfs.mkdir(child.dst);
        result.directories += 1;
        stack.push(child);
      } else if (dirent.isSymbolicLink() || dirent.isFile()) {
        leaves.push(dirent);
      }
      // sockets/fifos/devices are never part of a toolchain; skip.
    }
    await forEachLimit(leaves, SEAL_COPY_CONCURRENCY, async (dirent) => {
      const src = path.join(frame.src, dirent.name);
      const dst = path.join(frame.dst, dirent.name);
      if (dirent.isSymbolicLink()) {
        await sfs.symlink(await sfs.readlink(src), dst);
        result.symlinks += 1;
        return;
      }
      const size = (await sfs.lstat(src)).size;
      await sfs.copyFile(src, dst);
      result.files += 1;
      result.bytes += size;
    });
  }

  const binSrc = path.join(cargoHome, "bin");
  const binDst = path.join(stagingDir, STAGED_CARGO_BIN);
  let binDstReady = false;
  for (const name of opts.proxies) {
    const src = path.join(binSrc, name);
    let st: fs.Stats;
    try {
      st = await sfs.lstat(src);
    } catch (err) {
      const code = errnoCode(err);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    if (!st.isSymbolicLink() && !st.isFile()) continue;
    if (!binDstReady) {
      await sfs.mkdir(binDst);
      binDstReady = true;
    }
    const dst = path.join(binDst, name);
    if (st.isSymbolicLink()) {
      await sfs.symlink(await sfs.readlink(src), dst);
    } else {
      await sfs.copyFile(src, dst);
    }
    result.proxies += 1;
  }

  if (opts.includeUpdateHash) {
    const src = path.join(rustupHome, "update-hashes", toolchainDir);
    if (await soloPathExists(src, sfs)) {
      const dstDir = path.join(stagingDir, STAGED_UPDATE_HASHES);
      await sfs.mkdir(dstDir);
      await sfs.copyFile(src, path.join(dstDir, toolchainDir));
      result.updateHash = true;
    }
  }
  return result;
}

/**
 * Apply one staged leaf (file or symlink) to a live destination that is
 * known to be absent. Files are hardlinked when possible (constant time,
 * #331) and copied otherwise. Returns false when the entry kind is not
 * applicable.
 */
async function applyStagedLeaf(src: string, dst: string, sfs: SoloFs): Promise<boolean> {
  const st = await sfs.lstat(src);
  if (st.isSymbolicLink()) {
    await sfs.symlink(await sfs.readlink(src), dst);
    return true;
  }
  if (!st.isFile()) return false;
  try {
    await sfs.link(src, dst);
  } catch {
    await sfs.copyFile(src, dst);
  }
  return true;
}

/**
 * Move a sealed toolchain from a restored staging tree into place.
 *
 * The toolchain directory is renamed into `<rustupHome>/toolchains/`
 * (constant time); an existing directory of the same name is replaced,
 * because the cache key pins its exact content. Cross-device staging
 * (EXDEV/EPERM) falls back to the hardlink-then-copy walk. Proxies and
 * the update-hash file are applied ONLY when the live destination is
 * missing: an existing rustup proxy is never overwritten.
 */
export async function applySealedToolchain(opts: {
  stagedRoot: string;
  rustupHome: string;
  cargoHome: string;
  toolchainDir: string;
  fs?: SoloFs;
}): Promise<{ renamed: boolean; proxiesApplied: number; updateHashApplied: boolean }> {
  const sfs = opts.fs ?? defaultSoloFs;
  const { stagedRoot, rustupHome, cargoHome, toolchainDir } = opts;
  const toolchainsDir = path.join(rustupHome, "toolchains");
  await sfs.mkdir(toolchainsDir);
  const src = path.join(stagedRoot, STAGED_TOOLCHAINS, toolchainDir);
  const dest = path.join(toolchainsDir, toolchainDir);
  if (await soloEntryPresent(dest, sfs)) await sfs.rm(dest);

  let renamed = false;
  try {
    await sfs.rename(src, dest);
    renamed = true;
  } catch (err) {
    const code = errnoCode(err);
    if (code !== "EXDEV" && code !== "EPERM") throw err;
    await sfs.mkdir(dest);
    await walkAndApply(src, src, dest, sfs, () => {});
  }

  let proxiesApplied = 0;
  const binSrc = path.join(stagedRoot, STAGED_CARGO_BIN);
  let binEntries: fs.Dirent[] = [];
  try {
    binEntries = await sfs.readdir(binSrc);
  } catch {
    binEntries = [];
  }
  if (binEntries.length > 0) {
    const binDst = path.join(cargoHome, "bin");
    await sfs.mkdir(binDst);
    for (const entry of binEntries) {
      const liveAbs = path.join(binDst, entry.name);
      if (await soloEntryPresent(liveAbs, sfs)) continue;
      if (await applyStagedLeaf(path.join(binSrc, entry.name), liveAbs, sfs)) proxiesApplied += 1;
    }
  }

  let updateHashApplied = false;
  const hashSrc = path.join(stagedRoot, STAGED_UPDATE_HASHES, toolchainDir);
  if (await soloEntryPresent(hashSrc, sfs)) {
    const hashDir = path.join(rustupHome, "update-hashes");
    const hashDst = path.join(hashDir, toolchainDir);
    if (!(await soloEntryPresent(hashDst, sfs))) {
      await sfs.mkdir(hashDir);
      updateHashApplied = await applyStagedLeaf(hashSrc, hashDst, sfs);
    }
  }
  return { renamed, proxiesApplied, updateHashApplied };
}

/**
 * #525 T6 / #507 item 3: every `rust-std-<target>` that rustup lists in
 * `<toolchainPath>/lib/rustlib/components` must ship a
 * `lib/rustlib/<target>/lib/libcore-*.rlib`. Covers targets that the
 * caller never declared (a poisoned entry that claims a target without
 * its std).
 */
export async function verifyListedTargetStd(opts: {
  toolchainPath: string;
  fs?: SoloFs;
}): Promise<{ ok: boolean; listed: string[]; missing: string[] }> {
  const sfs = opts.fs ?? defaultSoloFs;
  const rustlib = path.join(opts.toolchainPath, "lib", "rustlib");
  let text: string;
  try {
    text = await sfs.readFile(path.join(rustlib, "components"));
  } catch {
    return { ok: false, listed: [], missing: ["lib/rustlib/components"] };
  }
  const listed: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("rust-std-")) continue;
    const target = line.slice("rust-std-".length);
    if (target && !listed.includes(target)) listed.push(target);
  }
  const missing: string[] = [];
  for (const target of listed) {
    let names: string[];
    try {
      names = (await sfs.readdir(path.join(rustlib, target, "lib"))).map((d) => d.name);
    } catch {
      names = [];
    }
    if (!names.some((name) => /^libcore-.*\.rlib$/.test(name))) missing.push(target);
  }
  return { ok: missing.length === 0, listed, missing };
}

/**
 * Hardlink-then-copy walk of a staged tree onto a live directory. Used
 * only when `applySealedToolchain` cannot rename across devices.
 */
async function walkAndApply(
  base: string,
  dir: string,
  liveBase: string,
  sfs: SoloFs,
  onApply: (kind: "file" | "symlink") => void,
  counters?: { hardlink: number; copy: number },
): Promise<void> {
  const dirents = await sfs.readdir(dir);
  for (const d of dirents) {
    const abs = path.join(dir, d.name);
    const rel = path.relative(base, abs);
    const liveAbs = path.join(liveBase, rel);
    if (d.isDirectory()) {
      await sfs.mkdir(liveAbs);
      await walkAndApply(base, abs, liveBase, sfs, onApply, counters);
    } else if (d.isSymbolicLink()) {
      const target = await sfs.readlink(abs);
      try {
        await sfs.rm(liveAbs);
      } catch { /* */ }
      try {
        await sfs.symlink(target, liveAbs);
        onApply("symlink");
      } catch { /* */ }
    } else if (d.isFile()) {
      await sfs.mkdir(path.dirname(liveAbs));
      // #331: prefer hardlink over copyFile. On hosted runners the
      // staging dir and the live RUSTUP_HOME are on the same
      // filesystem; hardlink is constant-time (creates a new
      // directory entry pointing at the same inode) vs ~5s of
      // sequential copy I/O for the ~580 MB toolchain content.
      // Falls back to copyFile on cross-device (EXDEV) or
      // filesystems that don't allow hardlinks (EPERM).
      try {
        await sfs.link(abs, liveAbs);
        if (counters) counters.hardlink += 1;
      } catch (err) {
        const code = errnoCode(err);
        if (code === "EEXIST") {
          await sfs.rm(liveAbs).catch(() => undefined);
          try {
            await sfs.link(abs, liveAbs);
            if (counters) counters.hardlink += 1;
          } catch {
            await sfs.copyFile(abs, liveAbs);
            if (counters) counters.copy += 1;
          }
        } else {
          await sfs.copyFile(abs, liveAbs);
          if (counters) counters.copy += 1;
        }
      }
      onApply("file");
    }
  }
}

/**
 * Tar+zstd the staging directory and upload via `@actions/cache`.
 * Caller must have already populated `stagingDir` via sealToolchainForSave.
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
  /** A validated-bad entry was deleted; do not let a stale listing suppress repair. */
  skipExistingProbe?: boolean;
  /** Test seam for cache upload. */
  saveCache?: (paths: string[], key: string) => Promise<number>;
  /** Test seam for exact-key lookup after a lost save race. */
  lookupExactKey?: (paths: string[], key: string) => Promise<string | undefined>;
  /** Test seam for archive creation. */
  compress?: typeof compressCache;
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
    const compress = await (opts.compress ?? compressCache)({
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
  if (!opts.skipExistingProbe) {
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
  }

  try {
    const id = await (opts.saveCache ?? cache.saveCache)([archivePath], key);
    if (id <= 0) {
      if (opts.lookupExactKey) {
        const lookup = opts.lookupExactKey;
        const existing = await lookup([archivePath], key);
        if (existing === key) {
          log(`solo-toolchain-cache: save lost a repair race, but exact replacement now exists key=${key}`);
          return {
            status: "race-precheck-skipped",
            archiveBytes,
            inflatedBytes,
            fileCount,
            archivePath,
          };
        }
      }
      return {
        status: "failed",
        error: `cache upload returned non-positive id=${id}; replacement was not proven`,
        archivePath,
      };
    }
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
 * Try to restore the solo cache. Hits decompress the archive into
 * `<rustupHome>/.setup-soldr-solo-restore/` and move the sealed toolchain
 * directory into `<rustupHome>/toolchains/` (see `applySealedToolchain`);
 * extracting on RUSTUP_HOME's filesystem keeps that move a rename even
 * when RUNNER_TEMP is a separate mount (job containers). Misses leave the
 * runtime untouched and the normal ensure-rust-toolchain path proceeds.
 */
export async function restoreSoloCache(opts: {
  keys: SoloCacheKeys;
  rustupHome: string;
  cargoHome: string;
  /** `<release>-<host>`; the archive must hold exactly this directory. */
  toolchainDir: string;
  stagingDir: string;
  log: (msg: string) => void;
  /**
   * Canonical archive path — must match the one saveSoloCache used,
   * or @actions/cache returns MISS due to version-from-paths mismatch
   * (see #316). Defaults to soloCacheArchivePath(dirname(stagingDir)).
   */
  cacheArchivePath?: string;
  fs?: SoloFs;
  /** Test seam for the cache download. Defaults to `cache.restoreCache`. */
  restoreCache?: (paths: string[], key: string, restoreKeys: string[]) => Promise<string | undefined>;
  /** Test seam for archive extraction. Defaults to `decompressCache`. */
  decompress?: typeof decompressCache;
}): Promise<SoloRestoreResult> {
  const { keys, rustupHome, cargoHome, toolchainDir, stagingDir, log } = opts;
  const sfs = opts.fs ?? defaultSoloFs;
  const restoreCache =
    opts.restoreCache ??
    ((paths: string[], key: string, restoreKeys: string[]) => cache.restoreCache(paths, key, restoreKeys));
  const decompress = opts.decompress ?? decompressCache;
  // #316: use the canonical archive path that saveSoloCache also uses.
  // Different paths → different cache version → permanent MISS.
  const archivePath = opts.cacheArchivePath ?? soloCacheArchivePath(path.dirname(stagingDir));
  await sfs.mkdir(path.dirname(archivePath));
  await sfs.rm(archivePath);

  let matched: string | undefined;
  try {
    matched = await restoreCache([archivePath], keys.exact, keys.fallbacks);
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
    archiveBytes = (await sfs.stat(archivePath)).size;
  } catch {
    // archive may not have actually landed; treat as miss
    return { hit: false, matchedKey: matched, restoredBytes: 0, archivePath: null, verified: false };
  }
  const magic = await detectCompressMagic(archivePath);
  const haveEncryptKey = (process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] ?? "").trim().length > 0;
  if (magic !== "zstd" && magic !== "gzip" && !haveEncryptKey) {
    log(`solo-toolchain-cache: restored archive has unknown codec, treating as miss`);
    return { hit: false, matchedKey: matched, restoredBytes: archiveBytes, archivePath, verified: false };
  }
  const extractRoot = path.join(rustupHome, SOLO_RESTORE_EXTRACT_DIR);
  try {
    return await extractAndApplySoloArchive({
      archivePath,
      archiveBytes,
      matched,
      exactKey: keys.exact,
      stagingOut: path.join(extractRoot, "staged"),
      rustupHome,
      cargoHome,
      toolchainDir,
      log,
      sfs,
      decompress,
    });
  } finally {
    await sfs.rm(extractRoot).catch(() => undefined);
  }
}

async function extractAndApplySoloArchive(opts: {
  archivePath: string;
  archiveBytes: number;
  matched: string;
  exactKey: string;
  stagingOut: string;
  rustupHome: string;
  cargoHome: string;
  toolchainDir: string;
  log: (msg: string) => void;
  sfs: SoloFs;
  decompress: typeof decompressCache;
}): Promise<SoloRestoreResult> {
  const { archivePath, archiveBytes, matched, stagingOut, rustupHome, cargoHome, toolchainDir, log, sfs, decompress } =
    opts;
  try {
    await sfs.rm(stagingOut);
    // matched is the actual key the restored entry was stored under, which
    // is what the encryption AAD was bound to on save.
    await decompress({ archivePath, targetDir: stagingOut, cacheKey: matched });
  } catch (err) {
    log(`solo-toolchain-cache: decompress failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: matched, restoredBytes: archiveBytes, archivePath, verified: false };
  }
  // decompressCache extracts to dirname(targetDir)/<basename>/, so the
  // staged content lands under stagingOut. A v4 archive holds exactly the
  // one sealed toolchain directory; anything else is a poisoned entry the
  // caller repairs.
  let toolchainNames: string[];
  try {
    toolchainNames = (await sfs.readdir(path.join(stagingOut, STAGED_TOOLCHAINS))).map((d) => d.name);
  } catch {
    toolchainNames = [];
  }
  if (toolchainNames.length !== 1 || toolchainNames[0] !== toolchainDir) {
    log(`solo-toolchain-cache: archive does not hold exactly ${toolchainDir}`);
    return { hit: false, matchedKey: matched, restoredBytes: archiveBytes, archivePath, verified: false };
  }
  try {
    const applied = await applySealedToolchain({
      stagedRoot: stagingOut,
      rustupHome,
      cargoHome,
      toolchainDir,
      fs: sfs,
    });
    log(
      `solo-toolchain-cache: restored matched=${matched} archive=${archiveBytes}B ` +
        `dir=${toolchainDir} renamed=${applied.renamed} proxies=${applied.proxiesApplied}`,
    );
  } catch (err) {
    log(`solo-toolchain-cache: apply failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: matched, restoredBytes: archiveBytes, archivePath, verified: false };
  }
  return {
    hit: matched === opts.exactKey,
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
  expectedTargets?: string[];
  expectedComponents?: string[];
  channel: string;
  rustupCommand: string;
  log: (msg: string) => void;
  /** Test seam; production invokes rustup with the supplied arguments. */
  runRustup?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Test seam for file-based components such as rust-src. */
  pathExists?: (candidate: string) => Promise<boolean>;
}): Promise<{ match: boolean; observedRelease: string | null }> {
  const {
    expectedRelease,
    expectedTargets = [],
    expectedComponents = [],
    channel,
    rustupCommand,
    log,
  } = opts;
  const runRustup = opts.runRustup ?? (async (args: string[]) => {
    let stdout = "";
    let stderr = "";
    const code = await exec.exec(rustupCommand, args, {
      silent: true,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Buffer) => { stdout += data.toString("utf8"); },
        stderr: (data: Buffer) => { stderr += data.toString("utf8"); },
      },
    });
    return { code, stdout, stderr };
  });
  let releaseMatch = true;
  let observedRelease: string | null = null;
  if (expectedRelease.trim()) {
    let version: { code: number; stdout: string; stderr: string };
    try {
      version = await runRustup(["run", channel, "rustc", "--version"]);
    } catch (err) {
      log(`solo-toolchain-cache: rustc --version threw: ${err instanceof Error ? err.message : String(err)}`);
      return { match: false, observedRelease: null };
    }
    if (version.code !== 0) {
      log(`solo-toolchain-cache: rustup run ${channel} rustc --version exited ${version.code}; cannot verify restore`);
      return { match: false, observedRelease: null };
    }
    const match = version.stdout.trim().match(/^rustc\s+(\S+)/);
    observedRelease = match ? (match[1] ?? null) : null;
    if (observedRelease === null) {
      log(`solo-toolchain-cache: rustc --version output not parseable: ${version.stdout.trim()}`);
      return { match: false, observedRelease: null };
    }
    releaseMatch = observedRelease === expectedRelease;
    log(
      `solo-toolchain-cache: verify rustc release expected=${expectedRelease} observed=${observedRelease} match=${releaseMatch}`,
    );
  }

  const targets = [...new Set(expectedTargets.map((target) => target.trim()).filter(Boolean))];
  const runTargetProbe = async (target: string) => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-soldr-target-probe-"));
    const source = path.join(tempDir, "probe.rs");
    const output = path.join(tempDir, "probe.rmeta");
    await fsp.writeFile(source, "pub fn setup_soldr_target_probe() {}\n", "utf8");
    let stderr = "";
    try {
      const probe = await runRustup(["run", channel, "rustc", "--target", target, "--crate-type", "lib", "--emit", "metadata", source, "-o", output]);
      stderr = probe.stderr;
      return { code: probe.code, stderr };
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  };
  let targetsMatch = true;
  for (const target of targets) {
    let probe: { code: number; stderr: string };
    try {
      probe = await runTargetProbe(target);
    } catch (err) {
      probe = {
        code: -1,
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
    if (probe.code !== 0) {
      targetsMatch = false;
      log(`solo-toolchain-cache: target std probe failed target=${target} exit=${probe.code}: ${probe.stderr.trim()}`);
    } else {
      log(`solo-toolchain-cache: target std probe passed target=${target}`);
    }
  }
  let componentsMatch = true;
  const components = [...new Set(expectedComponents.map((component) => component.trim()).filter(Boolean))];
  if (components.length > 0) {
    let listed: { code: number; stdout: string; stderr: string };
    try {
      listed = await runRustup(["component", "list", "--toolchain", channel, "--installed"]);
    } catch (err) {
      listed = { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
    const installed = new Set(
      listed.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/, 1)[0]).filter((name): name is string => Boolean(name)),
    );
    const installedName = (component: string): string =>
      component.endsWith("-preview") ? component.slice(0, -"-preview".length) : component;
    const missing = components.filter((component) => {
      const normalized = installedName(component);
      return ![...installed].some((name) => name === normalized || name.startsWith(`${normalized}-`));
    });
    componentsMatch = listed.code === 0 && missing.length === 0;
    if (!componentsMatch) {
      log(`solo-toolchain-cache: component verification failed channel=${channel} missing=${missing.join(",") || "list-command-failed"}`);
    }
    const executableComponents: Record<string, string> = {
      rustfmt: "rustfmt",
      clippy: "clippy-driver",
      miri: "cargo-miri",
      "rust-analyzer": "rust-analyzer",
    };
    for (const component of components) {
      const executable = executableComponents[installedName(component)];
      if (!executable) continue;
      const probe = await runRustup(["run", channel, executable, "--version"]).catch((err) => ({
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      }));
      if (probe.code !== 0) {
        componentsMatch = false;
        log(`solo-toolchain-cache: component payload probe failed component=${component} exit=${probe.code}`);
      }
    }
    if (components.includes("rust-src")) {
      const sysroot = await runRustup(["run", channel, "rustc", "--print", "sysroot"]).catch(() => ({ code: -1, stdout: "", stderr: "" }));
      const sourceManifest = path.join(sysroot.stdout.trim(), "lib", "rustlib", "src", "rust", "library", "Cargo.toml");
      const pathExists = opts.pathExists ?? (async (candidate: string) => fsp.access(candidate).then(() => true, () => false));
      if (sysroot.code !== 0 || !(await pathExists(sourceManifest))) {
        componentsMatch = false;
        log("solo-toolchain-cache: component payload probe failed component=rust-src");
      }
    }
  }
  return { match: releaseMatch && targetsMatch && componentsMatch, observedRelease };
}
