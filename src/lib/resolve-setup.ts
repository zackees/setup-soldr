// Top-level resolve-setup entry point. Owned by Agent 1.
//
// Full port of resolve_setup.py::main(). Reads INPUT_* / GITHUB_* env vars,
// resolves the toolchain spec, derives all cache keys, computes the env
// exports + outputs the orchestrator needs.

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as core from "@actions/core";
import {
  cargoConfigHash,
  canonicalJsonStringify,
  normalizeBuildCacheMode,
  normalizeLegacyTargetCacheMode,
  normalizeTargetCacheBool,
  normalizeTargetCacheCompress,
  normalizeTargetCacheCompressLevel,
  normalizeTargetCacheProfile,
  pathForOutput,
  resolveLockfilePath,
  sanitizeFragment,
  setupCacheLayout,
  setupCachePaths,
  shortFileHash,
  shortJsonHash,
  targetCacheSoftBudget,
  targetEnvHash,
  workspaceManifestHash,
} from "./cache-keys.js";
import { createLogger } from "./log-utils.js";
import {
  detectMuslCcEnv,
  tripleToCcRsSuffix,
  type DetectMuslCcDeps,
  type MuslCcResolution,
} from "./detect-musl-cc.js";
import { buildOutputs } from "./build-outputs.js";
import {
  loadToolchainSpec,
  rollingToolchainAlias,
  systemRustupSatisfiesRequest,
  type SystemRustupProbeDeps,
} from "./toolchain.js";
import type {
  ActionContext,
  BuildCachePlan,
  CargoRegistryCachePlan,
  CompileCacheStatsMode,
  RawInputs,
  ResolveResult,
  SetupCachePlan,
  StatsMode,
  TargetCachePlan,
  ToolchainSpec,
} from "./types.js";

const FALSY_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);
const TRUTHY_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const ALLOWED_LINKER_VALUES = [
  "default",
  "platform-default",
  "ld",
  "mold",
  "rust-lld",
  "fast",
] as const;

// CARGO_MAKEFLAGS / MAKEFLAGS describe an in-process jobserver pipe whose
// FDs are closed once the producing process exits. Forwarding via $GITHUB_ENV
// causes "failed to connect to jobserver" warnings in every downstream step.
// See setup-soldr#71.
const GITHUB_ENV_DENY_LIST: ReadonlySet<string> = new Set(["CARGO_MAKEFLAGS", "MAKEFLAGS"]);

function expanduser(p: string, env: Record<string, string | undefined>): string {
  if (!p) return p;
  if (p.startsWith("~")) {
    const home = env["HOME"] || env["USERPROFILE"] || "";
    if (p === "~") return home;
    if (p.startsWith("~/") || p.startsWith("~\\")) {
      return path.join(home, p.slice(2));
    }
  }
  return p;
}

function resolveAbsolute(p: string, env: Record<string, string | undefined>): string {
  return path.resolve(expanduser(p, env));
}

export function readRawInputs(env: Record<string, string | undefined>): RawInputs {
  const get = (name: string): string => env[`INPUT_${name}`] ?? "";
  return {
    enable: get("ENABLE"),
    version: get("VERSION"),
    repo: get("REPO"),
    ref: get("REF"),
    cache: get("CACHE"),
    cacheDir: get("CACHE_DIR"),
    cacheKeySuffix: get("CACHE_KEY_SUFFIX"),
    toolchain: get("TOOLCHAIN"),
    toolchainFile: get("TOOLCHAIN_FILE"),
    trustMode: get("TRUST_MODE"),
    linker: get("LINKER"),
    compilePriority: get("COMPILE_PRIORITY"),
    timestamps: get("TIMESTAMPS"),
    lockfile: get("LOCKFILE"),
    buildCache: get("BUILD_CACHE"),
    buildCacheMode: get("BUILD_CACHE_MODE"),
    targetCache: get("TARGET_CACHE"),
    targetCacheMode: get("TARGET_CACHE_MODE"),
    targetDir: get("TARGET_DIR"),
    targetCacheProfile: get("TARGET_CACHE_PROFILE"),
    targetCacheStripDebuginfo: get("TARGET_CACHE_STRIP_DEBUGINFO"),
    targetCacheIncludeIncremental: get("TARGET_CACHE_INCLUDE_INCREMENTAL"),
    targetCacheIncludeBuildScriptBinaries: get("TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"),
    targetCacheCompress: get("TARGET_CACHE_COMPRESS"),
    targetCacheCompressLevel: get("TARGET_CACHE_COMPRESS_LEVEL"),
    sourceMtimeNormalize: get("SOURCE_MTIME_NORMALIZE"),
    cargoRegistryCache: get("CARGO_REGISTRY_CACHE"),
    compileCacheStats: get("COMPILE_CACHE_STATS"),
    shims: get("SHIMS"),
    stats: get("STATS"),
    debugMode: get("DEBUG"),
    cacheShutdownOnIdle: get("CACHE_SHUTDOWN_ON_IDLE"),
  };
}

/**
 * Parse the `cache-shutdown-on-idle` input into a seconds count.
 *
 * Accepts:
 *   - "" / "0" / "off" / "false" / "no" → null (disabled)
 *   - bare integer ("30")               → that many seconds
 *   - "<N>s" / "<N>m" / "<N>h"          → seconds / minutes / hours
 *
 * Throws on any other value so misspellings ("30sec", "thirty") surface
 * loudly at action start rather than silently being treated as "off".
 */
export function parseCacheShutdownOnIdleSeconds(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "0" || value === "off" || value === "false" || value === "no") {
    return null;
  }
  const m = value.match(/^(\d+)\s*(s|m|h)?$/);
  if (!m) {
    throw new Error(
      `invalid 'cache-shutdown-on-idle' input: '${raw}'. ` +
        "Expected <seconds>, <N>s, <N>m, <N>h, or empty/off/false to disable.",
    );
  }
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid 'cache-shutdown-on-idle' input: '${raw}'.`);
  }
  const unit = m[2] ?? "s";
  if (unit === "s") return n;
  if (unit === "m") return n * 60;
  return n * 3600;
}

/**
 * Detect cross-compile env vars the user has already set that soldr's
 * `linker: fast` default would silently overwrite (CARGO_TARGET_<TRIPLE>_LINKER
 * and CARGO_TARGET_<TRIPLE>_RUSTFLAGS). Returns the list of `NAME=value`
 * strings to surface in the deferral log. See issue #108.
 */
export function detectUserLinkerEnv(env: Record<string, string | undefined>): string[] {
  const hits: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || raw === "") continue;
    if (!name.startsWith("CARGO_TARGET_")) continue;
    if (name.endsWith("_LINKER") || name.endsWith("_RUSTFLAGS")) {
      hits.push(`${name}=${raw}`);
    }
  }
  hits.sort();
  return hits;
}

// Re-exports kept for backward compatibility with tests and external
// consumers that imported the musl cc-rs helpers from this module
// before the split. New code should import directly from
// ./detect-musl-cc.js.
export { detectMuslCcEnv, type MuslCcResolution, type DetectMuslCcDeps };

function normalizeStatsMode(raw: string): StatsMode {
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "summarize" || v === "detailed") return v;
  return "summarize";
}

function normalizeCompileCacheStats(raw: string): CompileCacheStatsMode {
  const v = raw.trim().toLowerCase();
  if (v === "none") return "none";
  if (v === "detailed" || v === "insights") return "detailed";
  return "summarize";
}

function isFalsy(value: string): boolean {
  return FALSY_VALUES.has(value.trim().toLowerCase());
}

function isTruthy(value: string): boolean {
  return TRUTHY_VALUES.has(value.trim().toLowerCase());
}

function defaultHomeDir(env: Record<string, string | undefined>, name: string): string {
  const home = env["HOME"] || env["USERPROFILE"] || os.homedir();
  return path.resolve(path.join(home, name));
}

function makeDirs(...paths: string[]): void {
  for (const p of paths) {
    fs.mkdirSync(p, { recursive: true });
  }
}

/**
 * Optional injectable dependencies for tests. Production code uses defaults.
 */
export interface ResolveSetupDeps {
  fetchReleaseTag?: (repo: string, version: string, env: Record<string, string | undefined>) => Promise<string>;
  systemRustup?: SystemRustupProbeDeps;
  systemRustupOverride?: (
    cargoHome: string,
    rustupHome: string,
    toolchain: ToolchainSpec,
  ) => Promise<boolean> | boolean;
}

async function fetchReleaseTagDefault(
  repo: string,
  version: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (version) {
    // For explicit (non-latest) versions, return as-is. Caller normalizes.
    return "";
  }
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "setup-soldr-action",
  };
  const token = (env["GITHUB_TOKEN"] ?? "").trim() || (env["INPUT_TOKEN"] ?? "").trim();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status} for ${repo}`);
    }
    const payload = (await response.json()) as unknown;
    if (typeof payload !== "object" || payload === null) {
      throw new Error(`unexpected GitHub release payload for ${repo}`);
    }
    const tag = (payload as Record<string, unknown>)["tag_name"];
    const tagName = typeof tag === "string" ? tag.trim() : "";
    if (!tagName) {
      throw new Error(`failed to resolve latest soldr release tag from ${repo}`);
    }
    return tagName;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSoldrReleaseVersion(
  repo: string,
  version: string,
  ref: string,
  env: Record<string, string | undefined>,
  deps?: ResolveSetupDeps,
): Promise<string> {
  if (ref.trim()) {
    return "";
  }
  const requested = version.trim();
  if (requested && requested.toLowerCase() !== "latest") {
    return requested.startsWith("v") ? requested : `v${requested}`;
  }
  const fetcher = deps?.fetchReleaseTag ?? fetchReleaseTagDefault;
  const tagName = await fetcher(repo, "", env);
  if (!tagName) {
    throw new Error(`failed to resolve latest soldr release tag from ${repo}`);
  }
  return tagName;
}

/**
 * Resolve setup state. The orchestrator calls this once at the start of the
 * action and uses the returned ResolveResult to drive every subsequent step.
 */
export async function resolveSetup(
  ctx: ActionContext,
  inputs: RawInputs,
  deps?: ResolveSetupDeps,
): Promise<ResolveResult> {
  const env = { ...ctx.env };

  // ---- timing seed ----
  const logStart = String(Math.floor(Date.now() / 1000));
  const timestamps = (inputs.timestamps && inputs.timestamps.trim()) || "true";
  env["SETUP_SOLDR_LOG_START_EPOCH"] = logStart;
  env["SETUP_SOLDR_TIMESTAMPS"] = timestamps;
  const logger = ctx.logger ?? createLogger(env);
  const log = (msg: string): void => logger.log(msg);

  if (!ctx.workspace) {
    throw new Error("ACTION_WORKSPACE / ctx.workspace must be set");
  }
  const workspace = path.resolve(ctx.workspace);
  const runnerTemp = ctx.runnerTemp
    ? path.resolve(ctx.runnerTemp)
    : path.resolve(path.join(workspace, ".tmp"));

  // ---- cache roots ----
  const requestedCacheDir = inputs.cacheDir.trim();
  const cacheRoot = requestedCacheDir
    ? resolveAbsolute(requestedCacheDir, env)
    : path.resolve(path.join(runnerTemp, "setup-soldr"));
  const soldrRoot = path.join(path.dirname(cacheRoot), `${path.basename(cacheRoot)}-soldr`);
  const cargoHomeInput = (env["CARGO_HOME"] ?? "").trim();
  const cargoHome = cargoHomeInput
    ? resolveAbsolute(cargoHomeInput, env)
    : defaultHomeDir(env, ".cargo");
  const binDir = path.join(cacheRoot, "bin");
  const setupCachePath = cacheRoot;
  const soldrBinCachePath = path.join(soldrRoot, "bin");
  const zccacheCacheDir = path.join(soldrRoot, "cache", "zccache");
  const thinTargetCacheBundlePath = path.join(
    path.dirname(cacheRoot),
    `${path.basename(cacheRoot)}-target-thin`,
  );
  // When the action is disabled (`enable: false`), we write a script-based
  // passthrough stub at soldrPath instead of installing the real binary.
  // The stub is a bash script on Unix and a .cmd shim on Windows — Windows
  // cannot spawn a script via the .exe extension without a real PE, so
  // soldrPath must end in .cmd in passthrough mode.
  const enableRaw = inputs.enable.trim() || "true";
  if (!TRUTHY_VALUES.has(enableRaw.toLowerCase()) && !FALSY_VALUES.has(enableRaw.toLowerCase())) {
    throw new Error(
      `invalid 'enable' input: '${enableRaw}'. Allowed: true | false`,
    );
  }
  const enabled = !FALSY_VALUES.has(enableRaw.toLowerCase());
  const soldrBinary = enabled
    ? process.platform === "win32"
      ? "soldr.exe"
      : "soldr"
    : process.platform === "win32"
      ? "soldr.cmd"
      : "soldr";
  const soldrPath = path.join(binDir, soldrBinary);

  // ---- toolchain ----
  const toolchain = await loadToolchainSpec({
    workspace,
    toolchainFile: inputs.toolchainFile || "rust-toolchain.toml",
    toolchainOverride: inputs.toolchain,
    log,
  });

  // ---- rustup home selection ----
  const explicitRustupHome = (env["RUSTUP_HOME"] ?? "").trim();
  let rustupHome: string;
  let rustupStrategy: "managed" | "system" | "explicit";
  if (explicitRustupHome) {
    rustupHome = resolveAbsolute(explicitRustupHome, env);
    rustupStrategy = "explicit";
  } else {
    const runnerRustupHome = defaultHomeDir(env, ".rustup");
    let satisfied = false;
    if (deps?.systemRustupOverride) {
      satisfied = await deps.systemRustupOverride(cargoHome, runnerRustupHome, toolchain);
    } else {
      satisfied = await systemRustupSatisfiesRequest({
        cargoHome,
        rustupHome: runnerRustupHome,
        toolchain,
        env,
        logger,
        deps: deps?.systemRustup,
      });
    }
    if (satisfied) {
      rustupHome = runnerRustupHome;
      rustupStrategy = "system";
    } else {
      rustupHome = path.join(cacheRoot, "rustup-home");
      rustupStrategy = "managed";
    }
  }

  const setupCachePathsList = setupCachePaths(setupCachePath, binDir, soldrBinCachePath, rustupHome);
  const setupCacheLayoutValue = setupCacheLayout(setupCachePath, rustupHome);

  for (const dir of [
    cacheRoot,
    soldrRoot,
    path.join(soldrRoot, "cache"),
    soldrBinCachePath,
    cargoHome,
    path.join(cargoHome, "bin"),
    rustupHome,
    binDir,
    zccacheCacheDir,
    thinTargetCacheBundlePath,
  ]) {
    makeDirs(dir);
  }

  const soldrRepo = inputs.repo.trim() || "zackees/soldr";
  const soldrRef = inputs.ref.trim();
  const soldrVersionRequested = inputs.version.trim();
  const soldrVersionResolved = await resolveSoldrReleaseVersion(
    soldrRepo,
    soldrVersionRequested,
    soldrRef,
    env,
    deps,
  );

  const toolchainSignature = {
    channel: toolchain.cacheChannel,
    profile: toolchain.profile,
    components: toolchain.components,
    targets: toolchain.targets,
    source: toolchain.source,
    file_hash: toolchain.fileHash,
    setup_cache_layout: setupCacheLayoutValue,
    soldr_repo: soldrRepo,
    soldr_ref: soldrRef || "release",
    soldr_version: soldrVersionResolved || soldrRef || "source-ref",
  };
  // Python uses json.dumps(sort_keys=True) without compact separators here,
  // so canonical_json_stringify is wrong; mirror Python's default separators
  // (", " and ": ") to match byte-for-byte.
  const signatureString = pythonDefaultJson(toolchainSignature);
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(signatureString, "utf8").digest("hex").slice(0, 16);

  const runnerOs = sanitizeFragment((env["ACTION_OS"] ?? process.platform).toLowerCase());
  const runnerArch = sanitizeFragment((env["ACTION_ARCH"] ?? "unknown").toLowerCase());
  const cachePrefix = `setup-soldr-v4-${runnerOs}-${runnerArch}`;
  let cacheKey = `${cachePrefix}-${digest}`;
  const wsManifestHash = await workspaceManifestHash(workspace);
  const cargoConfigHashValue = await cargoConfigHash(workspace);

  const suffix = inputs.cacheKeySuffix.trim();
  const sanitizedSuffix = suffix ? sanitizeFragment(suffix) : "";
  if (suffix) {
    cacheKey = `${cacheKey}-${sanitizedSuffix}`;
  }

  // ---- build cache ----
  const githubSha = (env["GITHUB_SHA"] ?? "").trim() || "nosha";
  let parentSha = (env["ACTION_PARENT_SHA"] ?? "").trim();
  if (parentSha === githubSha) {
    parentSha = "";
  }
  const buildCachePrefix = `setup-soldr-buildcache-v2-${runnerOs}-${runnerArch}`;
  const buildCacheToolchainPrefix = `${buildCachePrefix}-${digest}-`;
  let buildCacheKey = `${buildCacheToolchainPrefix}${githubSha}`;
  let buildCacheParentKey = parentSha ? `${buildCacheToolchainPrefix}${parentSha}` : "";

  // ---- target cache ----
  const targetDirInput = inputs.targetDir.trim() || "target";
  let targetCachePath = expanduser(targetDirInput, env);
  if (!path.isAbsolute(targetCachePath)) {
    targetCachePath = path.join(workspace, targetCachePath);
  }
  targetCachePath = path.resolve(targetCachePath);
  makeDirs(targetCachePath);
  const lockfilePath = resolveLockfilePath(workspace, targetCachePath, inputs.lockfile);
  const cargoLockHash = lockfilePath ? await shortFileHash(lockfilePath, "no-lock") : "no-lock";

  const legacyTargetCacheModeInput = inputs.targetCacheMode;
  const legacyTargetCacheMode = normalizeLegacyTargetCacheMode(legacyTargetCacheModeInput, log);
  const targetCacheProfile = normalizeTargetCacheProfile(inputs.targetCacheProfile);

  const targetCacheInputRaw = inputs.targetCache.trim() || "true";
  const targetCacheRequested =
    !isFalsy(targetCacheInputRaw) && legacyTargetCacheMode !== "off";

  const explicitBuildCacheMode = inputs.buildCacheMode.trim();
  const buildCacheMode = normalizeBuildCacheMode(
    inputs.buildCacheMode,
    legacyTargetCacheModeInput,
    !explicitBuildCacheMode && targetCacheRequested,
    log,
  );

  const buildCacheInputRaw = inputs.buildCache.trim() || "true";
  const buildCacheEnabled = !isFalsy(buildCacheInputRaw);
  const buildCacheRuntimeMode = buildCacheMode === "once" ? "full" : buildCacheMode;
  let targetCacheEnabled = buildCacheEnabled && targetCacheRequested;
  if (buildCacheMode === "thin" && cargoLockHash === "no-lock") {
    log("build-cache-mode 'thin' requires Cargo.lock; target artifact cache disabled.");
    targetCacheEnabled = false;
  }
  const [targetCacheBudgetBytes, targetCacheBudgetFiles] = targetCacheSoftBudget(
    targetCacheEnabled,
    buildCacheMode,
  );

  const targetShapeHash = shortJsonHash({
    target_dir: targetCachePath,
    target_dir_input: targetDirInput,
    target_env: targetEnvHash(env),
  });
  const targetInputsHash = shortJsonHash({
    cargo_config: cargoConfigHashValue,
    cargo_lock: cargoLockHash,
    manifest: wsManifestHash,
    target_shape: targetShapeHash,
    toolchain: digest,
  });
  const lockfileOnlyHash = shortJsonHash({
    cargo_lock: cargoLockHash,
    toolchain: digest,
  });
  const targetCacheBundlePath = thinTargetCacheBundlePath;
  const targetTreeCacheEnabled = targetCacheEnabled && buildCacheMode === "full";

  let targetCachePaths: string;
  let targetCacheEffectiveMode: "once" | "thin" | "full" | "off";
  let targetCachePrefix: string;
  let targetCacheLockPrefix: string;
  let targetCacheLockfilePrefix: string;
  let targetCacheKey: string;
  let targetCacheParentKey: string;

  if (!targetCacheEnabled) {
    targetCachePaths = "";
    targetCacheEffectiveMode = "off";
    targetCachePrefix = `setup-soldr-targetcache-off-v1-${runnerOs}-${runnerArch}`;
    targetCacheLockPrefix = "";
    targetCacheLockfilePrefix = "";
    targetCacheKey = `${targetCachePrefix}-${targetInputsHash}`;
    targetCacheParentKey = "";
  } else if (targetTreeCacheEnabled) {
    targetCachePaths = [targetCachePath, targetCacheBundlePath].join("\n");
    targetCacheEffectiveMode = buildCacheMode;
    targetCachePrefix = `setup-soldr-targetcache-${buildCacheMode}-v1-${runnerOs}-${runnerArch}`;
    const sf = sanitizedSuffix ? `${sanitizedSuffix}-` : "";
    targetCacheLockPrefix = `${targetCachePrefix}-${digest}-${cargoLockHash}-${targetShapeHash}-${sf}`;
    targetCacheLockfilePrefix = `${targetCachePrefix}-${lockfileOnlyHash}-${sf}`;
    targetCacheKey = `${targetCacheLockPrefix}${githubSha}`;
    targetCacheParentKey = parentSha ? `${targetCacheLockPrefix}${parentSha}` : "";
  } else {
    targetCachePaths = targetCacheBundlePath;
    targetCacheEffectiveMode = buildCacheMode;
    targetCachePrefix = `setup-soldr-targetcache-${buildCacheMode}-v1-${runnerOs}-${runnerArch}`;
    const sf = sanitizedSuffix ? `${sanitizedSuffix}-` : "";
    targetCacheLockPrefix = `${targetCachePrefix}-${targetInputsHash}-${sf}`;
    targetCacheLockfilePrefix = `${targetCachePrefix}-${lockfileOnlyHash}-${sf}`;
    targetCacheKey = `${targetCacheLockPrefix}${githubSha}`;
    targetCacheParentKey = parentSha ? `${targetCacheLockPrefix}${parentSha}` : "";
  }

  if (suffix) {
    buildCacheKey = `${buildCacheKey}-${sanitizedSuffix}`;
    if (buildCacheParentKey) {
      buildCacheParentKey = `${buildCacheParentKey}-${sanitizedSuffix}`;
    }
  }

  // ---- cargo registry cache ----
  const cargoRegistryCacheRequested = isTruthy(inputs.cargoRegistryCache.trim() || "true");
  const cargoRegistryCachePath = path.join(cargoHome, "registry");
  const cargoRegistryCachePrefix = `setup-soldr-cargoregistry-v1-${runnerOs}-${runnerArch}`;
  const cargoRegistryCacheRestorePrefix = `${cargoRegistryCachePrefix}-${cargoLockHash}-`;
  let cargoRegistryCacheKey = `${cargoRegistryCacheRestorePrefix}${digest}-${githubSha}`;
  if (suffix) {
    cargoRegistryCacheKey = `${cargoRegistryCacheKey}-${sanitizedSuffix}`;
  }
  const cargoRegistryCacheEnabled = cargoRegistryCacheRequested;
  if (cargoRegistryCacheEnabled) {
    makeDirs(cargoRegistryCachePath);
  }

  // ---- env exports ----
  const cacheShutdownOnIdleSeconds = parseCacheShutdownOnIdleSeconds(inputs.cacheShutdownOnIdle);

  const envExports: Record<string, string> = {};
  const setEnv = (name: string, value: string): void => {
    if (GITHUB_ENV_DENY_LIST.has(name)) return;
    envExports[name] = value;
  };
  setEnv("SOLDR_CACHE_DIR", soldrRoot);
  setEnv("CARGO_HOME", cargoHome);
  setEnv("RUSTUP_HOME", rustupHome);
  setEnv("ZCCACHE_CACHE_DIR", zccacheCacheDir);
  setEnv("SETUP_SOLDR_BUILD_CACHE_MODE", buildCacheMode);
  setEnv("SOLDR_BUILD_CACHE_MODE", buildCacheRuntimeMode);
  setEnv(
    "SOLDR_TARGET_CACHE_MODE",
    targetCacheEnabled ? buildCacheRuntimeMode : "off",
  );
  setEnv("SOLDR_TARGET_CACHE_DIR", targetCachePath);
  setEnv("SOLDR_TARGET_CACHE_BUNDLE_DIR", targetCacheBundlePath);
  setEnv("SOLDR_TARGET_CACHE_PROFILE", targetCacheProfile);

  const stripDebug = normalizeTargetCacheBool(
    "target-cache-strip-debuginfo",
    inputs.targetCacheStripDebuginfo,
  );
  if (stripDebug !== null) {
    setEnv("SOLDR_TARGET_CACHE_STRIP_DEBUGINFO", stripDebug);
  }
  const includeIncremental = normalizeTargetCacheBool(
    "target-cache-include-incremental",
    inputs.targetCacheIncludeIncremental,
  );
  if (includeIncremental !== null) {
    setEnv("SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL", includeIncremental);
  }
  const includeBuildScripts = normalizeTargetCacheBool(
    "target-cache-include-build-script-binaries",
    inputs.targetCacheIncludeBuildScriptBinaries,
  );
  if (includeBuildScripts !== null) {
    setEnv("SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES", includeBuildScripts);
  }
  const targetCacheCompress = normalizeTargetCacheCompress(inputs.targetCacheCompress);
  const targetCacheCompressLevel = normalizeTargetCacheCompressLevel(
    inputs.targetCacheCompressLevel,
  );
  setEnv("SOLDR_TARGET_CACHE_COMPRESS", targetCacheCompress);
  setEnv("SOLDR_TARGET_CACHE_COMPRESS_LEVEL", targetCacheCompressLevel);
  if (cargoRegistryCacheEnabled) {
    setEnv("SOLDR_SKIP_CARGO_REGISTRY_SAVE", "1");
  }
  setEnv("SOLDR_TARGET_CACHE_BACKEND", "local");
  setEnv("SETUP_SOLDR_TOOLCHAIN_CHANNEL", toolchain.channel);
  setEnv("SETUP_SOLDR_TOOLCHAIN_CACHE_CHANNEL", toolchain.cacheChannel);
  setEnv("SETUP_SOLDR_TOOLCHAIN_PROFILE", toolchain.profile);
  setEnv("SETUP_SOLDR_TOOLCHAIN_COMPONENTS", JSON.stringify(toolchain.components));
  setEnv("SETUP_SOLDR_TOOLCHAIN_TARGETS", JSON.stringify(toolchain.targets));
  setEnv("SETUP_SOLDR_LOG_START_EPOCH", logStart);
  setEnv("SETUP_SOLDR_TIMESTAMPS", timestamps);

  if (!FALSY_VALUES.has(timestamps.toLowerCase()) && env["NO_COLOR"] === undefined) {
    if (!env["CARGO_TERM_COLOR"]) setEnv("CARGO_TERM_COLOR", "always");
    if (!env["CLICOLOR_FORCE"]) setEnv("CLICOLOR_FORCE", "1");
    if (!env["FORCE_COLOR"]) setEnv("FORCE_COLOR", "1");
  }
  if (inputs.trustMode.trim()) {
    setEnv("SOLDR_TRUST_MODE", inputs.trustMode.trim());
  }
  const linkerRaw = inputs.linker.trim();
  if (linkerRaw === "") {
    const preset = detectUserLinkerEnv(env);
    if (preset.length > 0) {
      logger.info(
        `setup-soldr: deferring to user-set ${preset.join(", ")}; skipping default SOLDR_LINKER=fast injection. See https://github.com/zackees/setup-soldr/issues/108`,
      );
    } else {
      setEnv("SOLDR_LINKER", "fast");
      logger.warning(
        "setup-soldr: defaulting SOLDR_LINKER=fast (mold-if-on-PATH-else-rust-lld on Linux, rust-lld on macOS/Windows) for faster CI links. Soldr's native default is no injection, which produces a smaller build-cache and a slower link. Set `linker: platform-default` to opt out and keep cargo/rust-toolchain.toml in charge, or set `linker: <value>` to silence this warning.",
      );
    }
  } else if (!(ALLOWED_LINKER_VALUES as readonly string[]).includes(linkerRaw)) {
    throw new Error(
      `invalid 'linker' input: '${linkerRaw}'. Allowed: default | platform-default | ld | mold | rust-lld | fast`,
    );
  } else if (linkerRaw !== "default" && linkerRaw !== "platform-default") {
    setEnv("SOLDR_LINKER", linkerRaw);
  }
  const compilePriorityRaw = inputs.compilePriority.trim();
  if (compilePriorityRaw !== "") {
    setEnv("ZCCACHE_COMPILE_PRIORITY", compilePriorityRaw);
  }

  if (cacheShutdownOnIdleSeconds !== null) {
    // Set both env vars. zccache reads its own, sccache reads the
    // SCCACHE_-prefixed one; exporting both means a zccache fork that
    // still honors only the sccache name keeps working, and a vanilla
    // sccache invoked via this action would too.
    const seconds = String(cacheShutdownOnIdleSeconds);
    setEnv("ZCCACHE_IDLE_TIMEOUT", seconds);
    setEnv("SCCACHE_IDLE_TIMEOUT", seconds);
  }

  // Auto-export cc-rs cross-compile env for *-unknown-linux-musl triples
  // when the matching `<triple>-gcc/g++/ar` binaries are on PATH. cc-rs
  // strips the "-unknown-" segment when looking up cross compilers, so
  // archives that ship binaries with the full triple are missed without
  // these per-target overrides. See setup-soldr#... and the cc-rs docs.
  const muslCcHits = detectMuslCcEnv(env);
  for (const hit of muslCcHits) {
    const suffix = tripleToCcRsSuffix(hit.triple);
    for (const [name, value] of Object.entries(hit.exports)) {
      setEnv(name, value);
    }
    logger.warning(
      `setup-soldr: auto-exporting cc-rs cross-compile env for ${hit.triple} ` +
        `(CC_${suffix}=${hit.exports[`CC_${suffix}`]}, ` +
        `CXX_${suffix}=${hit.exports[`CXX_${suffix}`]}, ` +
        `AR_${suffix}=${hit.exports[`AR_${suffix}`]}) ` +
        "because cc-rs strips \"-unknown-\" from the triple when probing for a " +
        "cross compiler and would otherwise fall back to the host gcc. " +
        `Resolved: cc=${hit.resolvedPaths.cc}, cxx=${hit.resolvedPaths.cxx}, ar=${hit.resolvedPaths.ar}. ` +
        `Pre-set CC_${suffix} yourself to opt out.`,
    );
  }

  // ---- path additions ----
  const pathAdditions: string[] = [binDir, path.join(cargoHome, "bin")];

  // ---- logging summary ----
  log("setup-soldr cache plan");
  log(`cache key=${cacheKey}`);
  log(`cache restore-key=${cachePrefix}-`);
  log(`build-cache key=${buildCacheKey}`);
  log(`build-cache mode=${buildCacheMode}`);
  log(`build-cache soldr-mode=${buildCacheRuntimeMode}`);
  if (buildCacheParentKey) {
    log(`build-cache restore-key-parent=${buildCacheParentKey}`);
  }
  log(`build-cache restore-key-toolchain=${buildCacheToolchainPrefix}`);
  log(`build-cache restore-key-os-arch=${buildCachePrefix}-`);
  log(`target-cache key=${targetCacheKey}`);
  log(`target-cache enabled=${targetCacheEnabled ? "true" : "false"}`);
  log(`target-cache mode=${targetCacheEffectiveMode}`);
  log("target-cache backend=local");
  if (targetCacheEnabled) {
    log(`target-cache soft-budget-bytes=${targetCacheBudgetBytes}`);
    log(`target-cache soft-budget-files=${targetCacheBudgetFiles}`);
  }
  log(`soldr repo=${soldrRepo}`);
  log(`soldr ref=${soldrRef || "release"}`);
  if (soldrVersionResolved) {
    log(`soldr version=${soldrVersionResolved}`);
  }
  log(`toolchain channel=${toolchain.channel}`);
  log(`toolchain cache-channel=${toolchain.cacheChannel}`);
  log(`rustup strategy=${rustupStrategy}`);
  log(`setup-cache layout=${setupCacheLayoutValue}`);
  if (targetCacheParentKey) {
    log(`target-cache restore-key-parent=${targetCacheParentKey}`);
  }
  log(`target-cache restore-key-lock=${targetCacheLockPrefix}`);
  log(`target-cache restore-key-lockfile=${targetCacheLockfilePrefix}`);
  log(`target-cache paths=${targetCachePaths}`);
  log(`target-cache bundle-dir=${targetCacheBundlePath}`);
  log(`target-cache lockfile=${pathForOutput(workspace, lockfilePath)}`);
  log(`target-cache lockfile-hash=${cargoLockHash}`);

  // ---- assemble plans ----
  const setupCache: SetupCachePlan = {
    key: cacheKey,
    restorePrefix: `${cachePrefix}-`,
    paths: setupCachePathsList ? setupCachePathsList.split("\n") : [],
    setupCachePath,
    layout: setupCacheLayoutValue,
  };
  const buildCache: BuildCachePlan = {
    key: buildCacheKey,
    restoreKeyParent: buildCacheParentKey,
    restoreKeyToolchain: buildCacheToolchainPrefix,
    restoreKeyOsArch: `${buildCachePrefix}-`,
    path: zccacheCacheDir,
    mode: buildCacheMode,
  };
  const targetCache: TargetCachePlan = {
    enabled: targetCacheEnabled,
    key: targetCacheKey,
    restoreKeyParent: targetCacheParentKey,
    restoreKeyLock: targetCacheLockPrefix,
    restoreKeyLockfile: targetCacheLockfilePrefix,
    paths: targetCachePaths,
    bundlePath: targetCacheBundlePath,
    targetPath: targetCachePath,
    effectiveMode: targetCacheEffectiveMode,
    profile: targetCacheProfile,
    budgetBytes: targetCacheBudgetBytes,
    budgetFiles: targetCacheBudgetFiles,
    lockfilePath: pathForOutput(workspace, lockfilePath),
    lockfileHash: cargoLockHash,
  };
  const cargoRegistryCachePlan: CargoRegistryCachePlan = {
    enabled: cargoRegistryCacheEnabled,
    key: cargoRegistryCacheKey,
    restorePrefix: cargoRegistryCacheRestorePrefix,
    path: cargoRegistryCachePath,
  };

  // Avoid unused warnings on alias helper.
  void rollingToolchainAlias;
  void canonicalJsonStringify;

  const compileCacheStats = normalizeCompileCacheStats(inputs.compileCacheStats);
  const stats = normalizeStatsMode(inputs.stats);
  const debugMode = isTruthy(inputs.debugMode.trim() || "false");

  // ---- shims ----
  const shimsRaw = inputs.shims.trim() || "false";
  const shimsEnabled = !isFalsy(shimsRaw);
  const shimsDir = path.join(cacheRoot, "shims");

  return {
    enabled,
    workspace,
    cacheRoot,
    soldrRoot,
    binDir,
    cargoHome,
    rustupHome,
    soldrPath,
    soldrBinCachePath,
    toolchain,
    rustupStrategy,
    soldrRepo,
    soldrRef,
    soldrVersionRequested,
    soldrVersionResolved,
    setupCache,
    buildCache,
    targetCache,
    cargoRegistryCache: cargoRegistryCachePlan,
    targetCacheCompress,
    targetCacheCompressLevel,
    envExports,
    pathAdditions,
    logStartEpoch: logStart,
    timestamps,
    shimsEnabled,
    shimsDir,
    compileCacheStats,
    stats,
    debugMode,
    cacheShutdownOnIdleSeconds,
  };
}

/**
 * Apply ResolveResult to the runner: write $GITHUB_ENV, $GITHUB_PATH, and
 * $GITHUB_OUTPUT keys.
 */
export async function applyResolveResult(result: ResolveResult): Promise<void> {
  for (const [name, value] of Object.entries(result.envExports)) {
    if (GITHUB_ENV_DENY_LIST.has(name)) continue;
    core.exportVariable(name, value);
  }
  for (const p of result.pathAdditions) {
    core.addPath(p);
  }
  const outputs = buildOutputs(result);
  for (const [key, value] of Object.entries(outputs)) {
    core.setOutput(key, value);
  }
}

// Re-export buildOutputs for backward compatibility with existing
// test imports. New code should import directly from
// ./build-outputs.js.
export { buildOutputs };

// --------------------- Python-default JSON serialization ---------------------

/**
 * Mirror Python's `json.dumps(value, sort_keys=True)` with default separators
 * (", " between items, ": " between key/value). Used for the toolchain
 * signature digest where Python does NOT pass compact separators.
 */
export function pythonDefaultJson(value: unknown): string {
  return formatDefaultJson(value);
}

function formatDefaultJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatDefaultJson(item));
    return `[${parts.join(", ")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}: ${formatDefaultJson(obj[key])}`,
    );
    return `{${parts.join(", ")}}`;
  }
  return JSON.stringify(value);
}
