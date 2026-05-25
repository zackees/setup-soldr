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
  crossToolCacheKeyFor,
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
import {
  crossToolCachePathsFor,
  parseCrossTargets,
  parseCrossTool,
  toolsetFor,
  toolVersionsFor,
} from "./cross-bootstrap.js";
import { createLogger } from "./log-utils.js";
import {
  detectMuslCcEnv,
  tripleToCcRsSuffix,
  type DetectMuslCcDeps,
  type MuslCcResolution,
} from "./detect-musl-cc.js";
import { buildOutputs } from "./build-outputs.js";
import { readRawInputs } from "./raw-inputs.js";
import {
  detectUserLinkerEnv,
  normalizeCompileCacheStats,
  normalizeStatsMode,
  parseCacheShutdownOnIdleSeconds,
  parseRustBacktrace,
} from "./input-parsers.js";
import {
  fetchReleaseTagDefault,
  resolveSoldrReleaseVersion,
  type ResolveSetupDeps,
} from "./fetch-release.js";
import { pythonDefaultJson } from "./python-json.js";
import {
  loadToolchainSpec,
  rollingToolchainAlias,
  systemRustupSatisfiesRequest,
} from "./toolchain.js";
import type {
  ActionContext,
  BuildCachePlan,
  CargoRegistryCachePlan,
  CrossToolCachePlan,
  RawInputs,
  ResolveResult,
  SetupCachePlan,
  TargetCachePlan,
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

// Re-exports kept for backward compatibility with tests and external
// consumers that imported these symbols from this module before the
// split. New code should import directly from the named submodules
// (./raw-inputs.js, ./input-parsers.js, ./detect-musl-cc.js,
// ./fetch-release.js, ./build-outputs.js, ./python-json.js).
export {
  readRawInputs,
  parseCacheShutdownOnIdleSeconds,
  parseRustBacktrace,
  detectUserLinkerEnv,
  detectMuslCcEnv,
  buildOutputs,
  pythonDefaultJson,
  type MuslCcResolution,
  type DetectMuslCcDeps,
  type ResolveSetupDeps,
};

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
 * Pure helper: decide the final rustup strategy from the requested one and
 * the host platform. On macOS we always override `system` to `managed` to
 * avoid the pre-installed rustup toolchain conflicts (see setup-soldr#105).
 *
 * GitHub-hosted `macos-15` (ARM) runners ship with a stable rustup toolchain
 * that already includes `clippy`. Downstream actions that try to install a
 * different toolchain with clippy hit
 *   detected conflict: 'bin/cargo-clippy'
 * because rustup component add refuses to overwrite the existing binary in
 * the shared rustup home. Forcing the managed strategy gives setup-soldr its
 * own private rustup home so the pre-installed components cannot collide.
 *
 * `explicit` (user-provided RUSTUP_HOME) is left untouched on every platform
 * — opting in to a specific home means accepting any conflicts that come
 * with it.
 */
export function resolveRustupStrategy(opts: {
  requested: "managed" | "system" | "explicit";
  platform: NodeJS.Platform;
  warn?: (msg: string) => void;
}): "managed" | "system" | "explicit" {
  const { requested, platform, warn } = opts;
  if (platform === "darwin" && requested === "system") {
    warn?.(
      "setup-soldr: forcing rustup strategy to 'managed' on macOS to avoid " +
        "pre-installed rustup toolchain component conflicts (e.g. " +
        "\"detected conflict: 'bin/cargo-clippy'\" on macos-15 runners). " +
        "See https://github.com/zackees/setup-soldr/issues/105 for context. " +
        "This may change which setup-cache key is used compared to other " +
        "platforms.",
    );
    return "managed";
  }
  return requested;
}

// `fetchReleaseTagDefault` and `resolveSoldrReleaseVersion` live in
// ./fetch-release.js — used directly from resolveSetup() below.

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
    // Platform override: macOS pre-installed rustup toolchains conflict with
    // downstream component adds (setup-soldr#105). Force `managed` when the
    // initial selection landed on `system` so we get a private rustup home.
    const overridden = resolveRustupStrategy({
      requested: rustupStrategy,
      platform: process.platform,
      warn: (msg) => logger.warning(msg),
    });
    if (overridden !== rustupStrategy) {
      rustupStrategy = overridden;
      if (rustupStrategy === "managed") {
        rustupHome = path.join(cacheRoot, "rustup-home");
      }
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

  // `cache: "false"` is the umbrella switch. It originally only gated the
  // action-managed setup-cache (soldr binary + rustup state), but consumers
  // reasonably expect it to mean "no caching at all" — so when the umbrella
  // is off we force every per-layer flag off too AND tell soldr to skip its
  // zccache build-cache wrapper. See zccache#307 / zackees/setup-soldr#118
  // follow-up.
  const cacheUmbrellaEnabled = !isFalsy(inputs.cache.trim() || "true");

  const targetCacheInputRaw = inputs.targetCache.trim() || "true";
  const targetCacheRequested =
    cacheUmbrellaEnabled &&
    !isFalsy(targetCacheInputRaw) &&
    legacyTargetCacheMode !== "off";

  const explicitBuildCacheMode = inputs.buildCacheMode.trim();
  const buildCacheMode = normalizeBuildCacheMode(
    inputs.buildCacheMode,
    legacyTargetCacheModeInput,
    !explicitBuildCacheMode && targetCacheRequested,
    log,
  );

  const buildCacheInputRaw = inputs.buildCache.trim() || "true";
  const buildCacheEnabled = cacheUmbrellaEnabled && !isFalsy(buildCacheInputRaw);
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
  // setup-soldr#102: bundle additional `$CARGO_HOME` siblings into the same
  // cargo-registry archive so we close the cache-retention gaps without
  // introducing a new top-level cache layer or changing the cache key shape.
  //   - `.global-cache` — cargo's RFC-3413 GC sqlite database. Without it the
  //     per-job `cargo gc` sees fresh access times and conservatively keeps
  //     everything. Shared read-only dep between setup-soldr (persists) and
  //     soldr (reads via zackees/soldr#323). One-line leverage win.
  //   - `git`           — `$CARGO_HOME/git/{db,checkouts}/`. `db/` holds the
  //     bare mirrors of git-source crate deps and `checkouts/` holds the
  //     per-commit working trees derived from `db/`; both are required for
  //     cargo to build from a restored `db/`. Caching the parent `git/` dir
  //     covers both subtrees and any future siblings cargo introduces.
  // Siblings that don't exist on disk at save time (e.g. workspaces with no
  // git-source deps) are silently skipped by compressCache — see #102.
  const cargoRegistryCacheExtras = [".global-cache", "git"];
  const cargoRegistryCachePrefix = `setup-soldr-cargoregistry-v1-${runnerOs}-${runnerArch}`;
  const cargoRegistryCacheRestorePrefix = `${cargoRegistryCachePrefix}-${cargoLockHash}-`;
  let cargoRegistryCacheKey = `${cargoRegistryCacheRestorePrefix}${digest}-${githubSha}`;
  if (suffix) {
    cargoRegistryCacheKey = `${cargoRegistryCacheKey}-${sanitizedSuffix}`;
  }
  const cargoRegistryCacheEnabled = cacheUmbrellaEnabled && cargoRegistryCacheRequested;
  if (cargoRegistryCacheEnabled) {
    makeDirs(cargoRegistryCachePath);
  }

  // ---- env exports ----
  const cacheShutdownOnIdleSeconds = parseCacheShutdownOnIdleSeconds(inputs.cacheShutdownOnIdle);
  const rustBacktraceValue = parseRustBacktrace(inputs.rustBacktrace);

  const envExports: Record<string, string> = {};
  const setEnv = (name: string, value: string): void => {
    if (GITHUB_ENV_DENY_LIST.has(name)) return;
    envExports[name] = value;
  };
  setEnv("SOLDR_CACHE_DIR", soldrRoot);
  setEnv("CARGO_HOME", cargoHome);
  setEnv("RUSTUP_HOME", rustupHome);
  setEnv("ZCCACHE_CACHE_DIR", zccacheCacheDir);
  setEnv("SETUP_SOLDR_BUILD_CACHE_MODE", cacheUmbrellaEnabled ? buildCacheMode : "off");
  setEnv("SOLDR_BUILD_CACHE_MODE", cacheUmbrellaEnabled ? buildCacheRuntimeMode : "off");
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

  if (rustBacktraceValue !== null) {
    setEnv("RUST_BACKTRACE", rustBacktraceValue);
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
    extraBasenames: cargoRegistryCacheExtras,
  };

  // ---- per-(host × target) tool caches (setup-soldr#106) ----
  // Activation gate: only when `cross-targets` is non-empty AND
  // `cross-tool` isn't `none`. The cost (one extra actions/cache restore
  // per declared target on every run) is taken-by-choice — non-cross-
  // compiling consumers see zero behavior change.
  const crossToolCachePlans: CrossToolCachePlan[] = [];
  const crossTargetsList = parseCrossTargets(inputs.crossTargets);
  const crossToolMode = parseCrossTool(inputs.crossTool);
  if (cacheUmbrellaEnabled && crossToolMode !== "none" && crossTargetsList.length > 0) {
    const hostFragment = `${runnerOs}-${runnerArch}`;
    const soldrVerForKey =
      soldrVersionResolved.trim() || soldrVersionRequested.trim() || "unresolved";
    for (const target of crossTargetsList) {
      const toolVersions = toolVersionsFor({ host: hostFragment, target });
      const lanePaths = crossToolCachePathsFor({
        host: hostFragment,
        target,
        cargoHome,
        cacheRoot,
      });
      const laneKey = crossToolCacheKeyFor({
        host: hostFragment,
        target,
        toolVersions,
        soldrVer: soldrVerForKey,
      });
      crossToolCachePlans.push({
        host: hostFragment,
        target,
        toolVersions,
        key: laneKey,
        paths: lanePaths,
      });
    }
  }
  // Reference imports so the value-side helpers don't get tree-shaken
  // by the compiler when the plan list is empty.
  void toolsetFor;

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
    crossToolCaches: crossToolCachePlans,
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

// `buildOutputs` and `pythonDefaultJson` are re-exported at the top of
// this file from their dedicated submodules.
