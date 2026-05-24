// Cache key derivation helpers. Owned by Agent 1.
//
// Port of resolve_setup.py:
//   - _workspace_manifest_hash()
//   - _cargo_config_hash()
//   - _target_env_hash()
//   - _short_json_hash()
//   - _short_file_hash()
//   - _sanitize_fragment()
//   - normalize_build_cache_mode()
//   - normalize_target_cache_profile()
//   - normalize_target_cache_bool()
//   - normalize_target_cache_compress()
//   - normalize_target_cache_compress_level()
//   - _target_cache_soft_budget()
//   - _setup_cache_paths(), _setup_cache_layout()
//   - resolve_lockfile_path()
//
// All cache key derivation must be byte-identical to the Python output to
// avoid invalidating warm caches on existing consumer workflows.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TargetCacheProfile } from "./types.js";

const TARGET_CACHE_PROFILES: readonly TargetCacheProfile[] = ["thin-v1", "thin-v2"];
const TARGET_CACHE_BOOL_TRUE: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);
const TARGET_CACHE_BOOL_FALSE: ReadonlySet<string> = new Set(["false", "0", "no", "off"]);
const TARGET_CACHE_COMPRESS_CODECS = ["auto", "zstd", "none"] as const;
const TARGET_CACHE_COMPRESS_DEFAULT = "zstd" as const;
const TARGET_CACHE_COMPRESS_LEVEL_DEFAULT = "3";
const TARGET_CACHE_COMPRESS_LEVEL_MIN = 1;
const TARGET_CACHE_COMPRESS_LEVEL_MAX = 22;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TARGET_CACHE_SOFT_BUDGETS: Record<string, [number, number]> = {
  once: [1024 * 1024 * 1024, 8_000],
  thin: [512 * 1024 * 1024, 4_000],
  full: [2 * GIB, 12_000],
};

const IGNORED_MANIFEST_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "target",
  ".soldr",
  "node_modules",
]);

// --------------------- core hashing helpers ---------------------

/**
 * sha256 -> first 16 hex chars over the Python-equivalent
 * json.dumps(value, sort_keys=True, separators=(',', ':')) bytes.
 */
export function shortJsonHash(value: unknown): string {
  const serialized = canonicalJsonStringify(value);
  return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16);
}

/**
 * Deterministic JSON.stringify equivalent to Python's
 * json.dumps(sort_keys=True, separators=(',', ':')).
 *
 * Sorts object keys recursively at every level. Note: arrays preserve order.
 * Booleans/null encode as "true"/"false"/"null". Numbers encode like Python's
 * default json output for the integer cases we care about.
 */
export function canonicalJsonStringify(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // Python json by default refuses NaN/Infinity; we mirror by emitting null.
      return "null";
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => stringify(item));
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stringify(obj[key])}`);
    return `{${parts.join(",")}}`;
  }
  // Fallback: stringify other primitives via JSON.
  return JSON.stringify(value);
}

/**
 * sha256 -> first 16 hex over the file contents, or the `missing` sentinel
 * when the file does not exist.
 */
export async function shortFileHash(filePath: string, missing: string): Promise<string> {
  try {
    const contents = await fs.promises.readFile(filePath);
    return createHash("sha256").update(contents).digest("hex").slice(0, 16);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return missing;
    }
    throw err;
  }
}

/** Synchronous variant used internally by `workspaceManifestHash`. */
export function shortFileHashSync(filePath: string, missing: string): string {
  try {
    const contents = fs.readFileSync(filePath);
    return createHash("sha256").update(contents).digest("hex").slice(0, 16);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return missing;
    }
    throw err;
  }
}

// --------------------- fragment / normalize helpers ---------------------

export function sanitizeFragment(value: string): string {
  const replaced = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  const stripped = replaced.replace(/^-+/, "").replace(/-+$/, "");
  return stripped || "default";
}

export function normalizeTargetCacheProfile(value: string): TargetCacheProfile {
  const profile = value.trim().toLowerCase();
  if (!profile) {
    return "thin-v1";
  }
  if (!TARGET_CACHE_PROFILES.includes(profile as TargetCacheProfile)) {
    throw new Error(
      `invalid target-cache-profile '${value}'; expected thin-v1 or thin-v2`,
    );
  }
  return profile as TargetCacheProfile;
}

export function normalizeTargetCacheBool(
  inputName: string,
  value: string,
): "true" | "false" | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (TARGET_CACHE_BOOL_TRUE.has(normalized)) {
    return "true";
  }
  if (TARGET_CACHE_BOOL_FALSE.has(normalized)) {
    return "false";
  }
  throw new Error(
    `invalid ${inputName} '${value}'; expected true, false, 1, 0, yes, no, on, or off`,
  );
}

export function normalizeLegacyTargetCacheMode(value: string, log?: (m: string) => void): string {
  const mode = value.trim().toLowerCase();
  if (!mode) {
    return "";
  }
  if (mode === "hot") {
    log?.("target-cache-mode 'hot' is deprecated; using build-cache-mode 'thin'.");
    return "thin";
  }
  if (!["thin", "full", "off"].includes(mode)) {
    throw new Error(`invalid target-cache-mode '${value}'; expected thin, full, or off`);
  }
  return mode;
}

export function normalizeBuildCacheMode(
  value: string,
  legacyTargetMode: string,
  allowLegacyTranslation: boolean,
  log?: (m: string) => void,
): "once" | "thin" | "full" {
  const explicitMode = value.trim().toLowerCase();
  const mode = explicitMode || "once";
  if (!["once", "thin", "full"].includes(mode)) {
    throw new Error(`invalid build-cache-mode '${value}'; expected once, thin, or full`);
  }

  const legacyMode = normalizeLegacyTargetCacheMode(legacyTargetMode, log);
  if (
    allowLegacyTranslation &&
    !explicitMode &&
    (legacyMode === "thin" || legacyMode === "full")
  ) {
    log?.(
      `target-cache-mode '${legacyMode}' is deprecated; translating to build-cache-mode '${legacyMode}'.`,
    );
    return legacyMode;
  }
  return mode as "once" | "thin" | "full";
}

export function normalizeTargetCacheCompress(value: string): "auto" | "zstd" | "none" {
  const codec = value.trim().toLowerCase();
  if (!codec) {
    return TARGET_CACHE_COMPRESS_DEFAULT;
  }
  if (!(TARGET_CACHE_COMPRESS_CODECS as readonly string[]).includes(codec)) {
    const expected = TARGET_CACHE_COMPRESS_CODECS.join(", ");
    throw new Error(`invalid target-cache-compress '${value}'; expected ${expected}`);
  }
  return codec as "auto" | "zstd" | "none";
}

export function normalizeTargetCacheCompressLevel(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return TARGET_CACHE_COMPRESS_LEVEL_DEFAULT;
  }
  // Mirror Python int() semantics: accept optional leading sign, decimal digits only.
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error(
      `invalid target-cache-compress-level '${value}'; expected integer between ${TARGET_CACHE_COMPRESS_LEVEL_MIN} and ${TARGET_CACHE_COMPRESS_LEVEL_MAX}`,
    );
  }
  const level = Number(raw);
  if (
    !Number.isInteger(level) ||
    level < TARGET_CACHE_COMPRESS_LEVEL_MIN ||
    level > TARGET_CACHE_COMPRESS_LEVEL_MAX
  ) {
    throw new Error(
      `invalid target-cache-compress-level '${value}'; expected integer between ${TARGET_CACHE_COMPRESS_LEVEL_MIN} and ${TARGET_CACHE_COMPRESS_LEVEL_MAX}`,
    );
  }
  return String(level);
}

export function targetCacheSoftBudget(
  targetCacheEnabled: boolean,
  buildCacheMode: string,
): [string, string] {
  if (!targetCacheEnabled) {
    return ["", ""];
  }
  const budget = TARGET_CACHE_SOFT_BUDGETS[buildCacheMode];
  if (!budget) {
    throw new Error(`internal: unknown build-cache-mode '${buildCacheMode}' for budget lookup`);
  }
  return [String(budget[0]), String(budget[1])];
}

// --------------------- workspace / config / env hashes ---------------------

function* walkCargoManifests(workspace: string): IterableIterator<string> {
  // Mirror Path.rglob("Cargo.toml") with the same ignored-dirs filter.
  const stack: string[] = [workspace];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sort so traversal order is deterministic; the final list is sorted
    // again by relative path before hashing.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_MANIFEST_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile() && entry.name === "Cargo.toml") {
        yield full;
      }
    }
  }
}

function toPosixRelative(workspace: string, absolute: string): string {
  const rel = path.relative(workspace, absolute);
  return rel.split(path.sep).join("/");
}

function hasIgnoredPart(rel: string): boolean {
  for (const part of rel.split("/")) {
    if (IGNORED_MANIFEST_DIRS.has(part)) return true;
  }
  return false;
}

export async function workspaceManifestHash(workspace: string): Promise<string> {
  const hasher = createHash("sha256");
  const relatives: { rel: string; abs: string }[] = [];
  for (const abs of walkCargoManifests(workspace)) {
    const rel = toPosixRelative(workspace, abs);
    if (hasIgnoredPart(rel)) continue;
    relatives.push({ rel, abs });
  }
  // Python sorts the iterable from rglob; Path objects sort by their string
  // form (POSIX-style on Linux). To match, sort by the POSIX relative path.
  relatives.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  if (relatives.length === 0) {
    return "no-manifest";
  }
  for (const { rel, abs } of relatives) {
    hasher.update(Buffer.from(rel, "utf8"));
    hasher.update(Buffer.from([0]));
    const contents = await fs.promises.readFile(abs);
    hasher.update(contents);
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest("hex").slice(0, 16);
}

export async function cargoConfigHash(workspace: string): Promise<string> {
  const hasher = createHash("sha256");
  let matched = false;
  for (const relative of [".cargo/config.toml", ".cargo/config"]) {
    const abs = path.join(workspace, ...relative.split("/"));
    if (fs.existsSync(abs)) {
      matched = true;
      hasher.update(Buffer.from(relative, "utf8"));
      hasher.update(Buffer.from([0]));
      const contents = await fs.promises.readFile(abs);
      hasher.update(contents);
      hasher.update(Buffer.from([0]));
    }
  }
  return matched ? hasher.digest("hex").slice(0, 16) : "no-config";
}

export function targetEnvHash(env: Record<string, string | undefined>): string {
  const relevant: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      name === "CARGO_BUILD_TARGET" ||
      name === "CARGO_ENCODED_RUSTFLAGS" ||
      name === "CARGO_TARGET_DIR" ||
      name === "RUSTFLAGS" ||
      (name.startsWith("CARGO_TARGET_") && name.endsWith("_RUSTFLAGS"))
    ) {
      relevant[name] = value;
    }
  }
  return shortJsonHash(relevant);
}

// --------------------- lockfile resolution ---------------------

function expanduser(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
    if (p === "~") return home;
    if (p.startsWith("~/") || p.startsWith("~\\")) {
      return path.join(home, p.slice(2));
    }
  }
  return p;
}

function resolveWorkspacePath(workspace: string, value: string): string | null {
  const cleaned = value.trim();
  if (!cleaned) {
    return null;
  }
  let p = expanduser(cleaned);
  if (!path.isAbsolute(p)) {
    p = path.join(workspace, p);
  }
  return path.resolve(p);
}

export function resolveLockfilePath(
  workspace: string,
  targetCachePath: string,
  lockfileInput: string,
): string {
  const explicit = resolveWorkspacePath(workspace, lockfileInput);
  if (explicit !== null) {
    return explicit;
  }
  const candidates = [
    path.join(path.dirname(targetCachePath), "Cargo.lock"),
    path.join(workspace, "Cargo.lock"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  // Python: return the *first* candidate (parent of target dir + Cargo.lock).
  return path.resolve(candidates[0]!);
}

// --------------------- setup cache layout ---------------------

function isPathInside(parent: string, child: string): boolean {
  // Compare resolved paths to determine containment.
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export function setupCachePaths(
  setupCachePath: string,
  binDir: string,
  soldrBinCachePath: string,
  rustupHome: string,
): string {
  const paths: string[] = [binDir, soldrBinCachePath];
  // setup-soldr#102: always cache `~/.rustup/update-hashes/<channel>-<host>`.
  // These are ~64-byte manifest hashes that let `rustup update` short-circuit
  // without a dist-server roundtrip. The dir is tiny (KB range) and the
  // latency win is large, so we include it even on the `system` rustup layout
  // where the toolchains/ tree itself is shared with the runner image and
  // deliberately excluded. (Toolchains/settings.toml stay gated on
  // rustupHome being inside setupCachePath — those payloads are large and
  // only owned by the managed rustup layout.)
  paths.push(path.join(rustupHome, "update-hashes"));
  if (!isPathInside(setupCachePath, rustupHome)) {
    return paths.join("\n");
  }
  paths.push(path.join(rustupHome, "settings.toml"));
  paths.push(path.join(rustupHome, "toolchains"));
  return paths.join("\n");
}

export function setupCacheLayout(
  setupCachePath: string,
  rustupHome: string,
): "bin+soldr-bin" | "bin+soldr-bin+rustup" {
  return isPathInside(setupCachePath, rustupHome)
    ? "bin+soldr-bin+rustup"
    : "bin+soldr-bin";
}

/** Produce a path-style output: workspace-relative when inside workspace, else absolute. */
export function pathForOutput(workspace: string, p: string | null): string {
  if (p === null) return "";
  const rel = path.relative(workspace, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return p;
  }
  return rel;
}
