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
import { parseEncryptionKey } from "./cache-encrypt.js";
import { resolveDylintNightly } from "./dylint-nightly.js";
import {
  detectMuslCcEnv,
  tripleToCcRsSuffix,
  type DetectMuslCcDeps,
  type MuslCcResolution,
} from "./detect-musl-cc.js";
import { buildOutputs } from "./build-outputs.js";
import { readRawInputs } from "./raw-inputs.js";
import { timeSubPhase } from "./phase-timing.js";
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

function parseOptInBool(inputName: string, value: string, defaultValue = false): boolean {
  const raw = value.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (TRUTHY_VALUES.has(raw)) return true;
  if (FALSY_VALUES.has(raw)) return false;
  throw new Error(
    `invalid '${inputName}' input: '${value}'. Allowed: true | false`,
  );
}

function semverAtLeast(value: string, minimum: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]!), Number(m[2]!), Number(m[3]!)];
  };
  const got = parse(value);
  const want = parse(minimum);
  if (!got || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i]! > want[i]!) return true;
    if (got[i]! < want[i]!) return false;
  }
  return true;
}

function rustHostTriple(runnerOs: string, runnerArch: string): string {
  const osName = runnerOs.trim().toLowerCase();
  const archName = runnerArch.trim().toLowerCase();
  const arch =
    archName === "x64" || archName === "amd64"
      ? "x86_64"
      : archName === "arm64" || archName === "aarch64"
        ? "aarch64"
        : archName === "x86" || archName === "ia32"
          ? "i686"
          : sanitizeFragment(archName || "unknown");
  if (osName === "windows" || osName === "win32") return `${arch}-pc-windows-msvc`;
  if (osName === "macos" || osName === "darwin") return `${arch}-apple-darwin`;
  if (osName === "linux") return `${arch}-unknown-linux-gnu`;
  return `${arch}-${sanitizeFragment(osName || "unknown")}`;
}

function splitPathInput(value: string): string[] {
  return value
    .split(/[\r\n,]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function defaultDylintCachePaths(cargoHome: string, driverPath: string): string[] {
  return [
    path.join(cargoHome, "bin", "cargo-dylint*"),
    path.join(cargoHome, "bin", "dylint-link*"),
    path.join(cargoHome, ".crates.toml"),
    path.join(cargoHome, ".crates2.json"),
    driverPath,
  ];
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

/**
 * Detect the `SOLDR_ZCCACHE_PRIVATE` ↔ `ZCCACHE_CACHE_DIR` overlap.
 *
 * soldr#807 added `SOLDR_ZCCACHE_PRIVATE` as an opt-in that reroutes the
 * managed zccache cache to `<cwd>/.zccache` — but only when
 * `ZCCACHE_CACHE_DIR` is *not* explicitly set. setup-soldr always sets
 * `ZCCACHE_CACHE_DIR` to `<soldr-root>/cache/zccache`, so when a workflow
 * also sets `SOLDR_ZCCACHE_PRIVATE=1` (truthy: `1`/`true`/`yes`/`on`)
 * the env var becomes a silent no-op. Return a warning string the caller
 * should surface via `core.warning`; return `null` otherwise.
 */
export function detectZccachePrivateOverlap(
  env: Record<string, string | undefined>,
): string | null {
  const raw = (env["SOLDR_ZCCACHE_PRIVATE"] ?? "").trim().toLowerCase();
  if (!TRUTHY_VALUES.has(raw)) return null;
  return (
    "setup-soldr: SOLDR_ZCCACHE_PRIVATE is set but will be ignored — " +
    "setup-soldr pins ZCCACHE_CACHE_DIR=<soldr-root>/cache/zccache " +
    "explicitly, and soldr#807 makes explicit ZCCACHE_CACHE_DIR take " +
    "precedence over the private-session opt-in. The zccache cache " +
    "will stay in setup-soldr's managed location, not <cwd>/.zccache. " +
    "Unset ZCCACHE_CACHE_DIR (or run outside setup-soldr) to use the " +
    "private cache path."
  );
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
  const timestampFormatRaw = (inputs.timestampFormat || "").trim().toLowerCase();
  const VALID_TIMESTAMP_FORMATS = ["mmss", "seconds"] as const;
  if (timestampFormatRaw && !(VALID_TIMESTAMP_FORMATS as readonly string[]).includes(timestampFormatRaw)) {
    throw new Error(
      `invalid timestamp-format '${inputs.timestampFormat}'; expected one of ${VALID_TIMESTAMP_FORMATS.join(", ")}`,
    );
  }
  const timestampFormat: "mmss" | "seconds" =
    (timestampFormatRaw as "mmss" | "seconds") || "mmss";
  env["SETUP_SOLDR_LOG_START_EPOCH"] = logStart;
  env["SETUP_SOLDR_TIMESTAMPS"] = timestamps;
  env["SETUP_SOLDR_TIMESTAMP_FORMAT"] = timestampFormat;

  // ---- #387 Feature 1: cache encryption ----
  // Validate the key shape NOW (fail fast on a malformed key) and mark the
  // raw value as a GitHub Actions secret so any incidental log line that
  // captures it is auto-redacted. We do NOT keep the parsed Buffer in
  // ResolveResult — downstream cache layers re-read SETUP_SOLDR_CACHE_ENCRYPT_KEY
  // at the time of use and re-parse, so the key only exists in memory inside
  // the closure that needs it.
  const cacheEncryptKeyRaw = (inputs.cacheEncryptKey || "").trim();
  if (cacheEncryptKeyRaw) {
    core.setSecret(cacheEncryptKeyRaw);
    // Throw early with a clean diagnostic when the key shape is wrong. The
    // raw value is never echoed back in the error message.
    parseEncryptionKey(cacheEncryptKeyRaw);
  }
  const cacheEncryptOnFailureRaw = (inputs.cacheEncryptOnFailure || "error")
    .trim()
    .toLowerCase();
  if (cacheEncryptOnFailureRaw && !["error", "skip"].includes(cacheEncryptOnFailureRaw)) {
    throw new Error(
      `invalid cache-encrypt-on-failure '${inputs.cacheEncryptOnFailure}'; expected 'error' or 'skip'`,
    );
  }
  const cacheEncryptOnFailure: "error" | "skip" =
    cacheEncryptOnFailureRaw === "skip" ? "skip" : "error";

  if (cacheEncryptKeyRaw) {
    env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] = cacheEncryptKeyRaw;
    env["SETUP_SOLDR_CACHE_ENCRYPT_ON_FAILURE"] = cacheEncryptOnFailure;
  }
  const logger = ctx.logger ?? createLogger(env);
  const log = (msg: string): void => logger.log(msg);

  if (!ctx.workspace) {
    throw new Error("ACTION_WORKSPACE / ctx.workspace must be set");
  }
  const workspace = path.resolve(ctx.workspace);
  const runnerTemp = ctx.runnerTemp
    ? path.resolve(ctx.runnerTemp)
    : path.resolve(path.join(workspace, ".tmp"));
  const dylintModeEnabled = parseOptInBool("dylint", inputs.dylint, false);
  const explicitCargoRegistryCache = inputs.cargoRegistryCache.trim();

  // ---- cache-preset resolution (#251) ----
  // The umbrella `cache-preset` fills any cache-affecting input the consumer
  // left unset; explicit fine-grained inputs always win. Resolved BEFORE the
  // per-layer reads below so downstream logic only sees the post-preset
  // values. The historical default of each input is the fallback when
  // neither an explicit value nor a preset is set, which keeps behavior
  // identical for consumers who never set `cache-preset`.
  const cachePresetRaw = inputs.cachePreset.trim().toLowerCase();
  const validCachePresets = ["minimal", "foundation", "full"] as const;
  type CachePreset = (typeof validCachePresets)[number];
  if (cachePresetRaw && !(validCachePresets as readonly string[]).includes(cachePresetRaw)) {
    throw new Error(
      `invalid cache-preset '${inputs.cachePreset}'; expected one of ${validCachePresets.join(", ")}`,
    );
  }
  const cachePresetEffective = (cachePresetRaw || "") as "" | CachePreset;

  const cachePresetMap: Record<
    CachePreset,
    {
      buildCache: string;
      targetCache: string;
      cargoRegistryCache: string;
      prebuildDeps: string;
      buildCacheMode: string;
    }
  > = {
    minimal: {
      buildCache: "false",
      targetCache: "false",
      cargoRegistryCache: "false",
      prebuildDeps: "soldr-cook",
      buildCacheMode: "",
    },
    foundation: {
      buildCache: "true",
      targetCache: "false",
      cargoRegistryCache: "false",
      prebuildDeps: "soldr-cook",
      buildCacheMode: "",
    },
    full: {
      buildCache: "true",
      targetCache: "true",
      cargoRegistryCache: "true",
      prebuildDeps: "soldr-cook",
      buildCacheMode: "thin",
    },
  };
  const cachePresetCfg = cachePresetEffective ? cachePresetMap[cachePresetEffective] : null;

  // Explicit non-empty user value wins; else preset value when a preset is
  // set; else leave empty so the existing downstream fall-through
  // (`inputs.X.trim() || "<historical default>"`) applies as before. This
  // preserves behavior for consumers who never set `cache-preset` — only
  // unset inputs *under a preset* are filled here. Mutating `inputs` folds
  // the resolution into the single source of truth that downstream code
  // (here + main.ts + cook-cache.ts) reads from.
  if (cachePresetCfg) {
    const fillFromPreset = (explicit: string, presetValue: string): string => {
      const e = explicit.trim();
      return e ? e : presetValue;
    };
    inputs.buildCache = fillFromPreset(inputs.buildCache, cachePresetCfg.buildCache);
    inputs.targetCache = fillFromPreset(inputs.targetCache, cachePresetCfg.targetCache);
    inputs.cargoRegistryCache = fillFromPreset(
      inputs.cargoRegistryCache,
      cachePresetCfg.cargoRegistryCache,
    );
    inputs.prebuildDeps = fillFromPreset(inputs.prebuildDeps, cachePresetCfg.prebuildDeps);
    inputs.buildCacheMode = fillFromPreset(inputs.buildCacheMode, cachePresetCfg.buildCacheMode);
  }
  if (dylintModeEnabled) {
    if (!explicitCargoRegistryCache) inputs.cargoRegistryCache = "true";
    // Ordinary cook is stable/build-shaped and cannot warm Dylint's isolated
    // nightly/check-shaped tree. Dylint mode therefore always disables it.
    inputs.prebuildDeps = "none";
  }

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
  // #302: sub-phase timing on the awaits inside resolve so we can see
  // which step is dominating (toolchain-spec / rustup-probe / hash walks
  // / soldr-version fetch). Cheap finally-block bookkeeping; no behavior
  // change for callers.
  const toolchain = await timeSubPhase("resolve", "toolchain-spec", () =>
    loadToolchainSpec({
      workspace,
      toolchainFile: inputs.toolchainFile || "rust-toolchain.toml",
      toolchainOverride: inputs.toolchain,
      log,
    }),
  );

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
      satisfied = await timeSubPhase("resolve", "rustup-probe", () =>
        deps.systemRustupOverride!(cargoHome, runnerRustupHome, toolchain),
      );
    } else {
      satisfied = await timeSubPhase("resolve", "rustup-probe", () =>
        systemRustupSatisfiesRequest({
          cargoHome,
          rustupHome: runnerRustupHome,
          toolchain,
          env,
          logger,
          deps: deps?.systemRustup,
        }),
      );
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

  let setupCachePathsList = setupCachePaths(
    setupCachePath,
    binDir,
    soldrBinCachePath,
    rustupHome,
  );
  let setupCacheLayoutValue = setupCacheLayout(setupCachePath, rustupHome);
  if (dylintModeEnabled) {
    // The Dylint foundation owns exact nightly toolchain paths. Do not let
    // setup-cache's broad rustup directories overlap that layer or carry a
    // Dylint nightly into a later non-Dylint job.
    const rustupOwnedPaths = new Set([
      path.normalize(path.join(rustupHome, "update-hashes")),
      path.normalize(path.join(rustupHome, "settings.toml")),
      path.normalize(path.join(rustupHome, "toolchains")),
    ]);
    setupCachePathsList = setupCachePathsList
      .split(/\r?\n/)
      .filter((candidate) => !rustupOwnedPaths.has(path.normalize(candidate)))
      .join("\n");
    setupCacheLayoutValue = "bin+soldr-bin";
  }

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
  const soldrVersionResolved = await timeSubPhase("resolve", "soldr-version", () =>
    resolveSoldrReleaseVersion(soldrRepo, soldrVersionRequested, soldrRef, env, deps),
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
  // #295-followup: parallelize the two independent workspace-wide hash
  // walks. Both traverse different subsets of `workspace` (manifests
  // vs .cargo/config.toml) and have no shared state, so running them
  // sequentially just wastes resolve-phase wall clock. Cheap correctness
  // improvement; no behavior change.
  const [wsManifestHash, cargoConfigHashValue] = await timeSubPhase("resolve", "ws-hash", () =>
    Promise.all([workspaceManifestHash(workspace), cargoConfigHash(workspace)]),
  );

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
  // Build-cache key (setup-soldr#237): platform + toolchain (digest) + per-job
  // suffix + Cargo.lock — but NOT the commit SHA. Dropping the SHA is the fix:
  // it made the key exact-miss on every commit, after which the fallback grabbed
  // a *different* job's archive → 0 hits. We KEEP the per-job suffix (and scope
  // the fallback to it, see the BuildCachePlan below) so each job restores its
  // OWN store, warm across commits — sharing one store across jobs that compile
  // different things (check vs doc vs test) was over-broad and still hit 0%.
  // Assembled below once `cargoLockHash` is known.

  // ---- target cache ----
  const targetDirInput = inputs.targetDir.trim() || "target";
  let targetCachePath = expanduser(targetDirInput, env);
  if (!path.isAbsolute(targetCachePath)) {
    targetCachePath = path.join(workspace, targetCachePath);
  }
  targetCachePath = path.resolve(targetCachePath);
  makeDirs(targetCachePath);
  const lockfilePath = resolveLockfilePath(workspace, targetCachePath, inputs.lockfile);
  const cargoLockHash = lockfilePath
    ? await timeSubPhase("resolve", "lock-hash", () => shortFileHash(lockfilePath, "no-lock"))
    : "no-lock";

  // setup-soldr#237: per-job, SHA-independent build-cache key. The per-job
  // suffix keeps each job restoring its own store; dropping the SHA makes it
  // warm across commits. The fallback (BuildCachePlan below) is scoped to this
  // job prefix only, never another job's store.
  const buildCacheJobPrefix = `${buildCacheToolchainPrefix}${sanitizedSuffix ? `${sanitizedSuffix}-` : ""}`;
  const buildCacheKey = `${buildCacheJobPrefix}${cargoLockHash}`;
  const buildCacheParentKey = "";

  const legacyTargetCacheModeInput = inputs.targetCacheMode;
  const legacyTargetCacheMode = normalizeLegacyTargetCacheMode(legacyTargetCacheModeInput, log);
  const targetCacheProfile = normalizeTargetCacheProfile(inputs.targetCacheProfile);
  // #418: thin-v3 may select a cook-partitioned durable slice only once Soldr
  // can prove every Cargo fingerprint/build-script path's package owner. That
  // closure is not available yet, so the action and Soldr deliberately agree
  // on the safe zccache-all fallback. The policy+mode are part of the cache
  // namespace; do not let a v1/v2 bundle restore into this contract.
  const targetCachePolicyKey =
    targetCacheProfile === "thin-v3"
      ? "thin-v3-lifetime-partition-v1-zccache-all-v1"
      : targetCacheProfile;

  // `cache: "false"` is the umbrella switch. It originally only gated the
  // action-managed setup-cache (soldr binary + rustup state), but consumers
  // reasonably expect it to mean "no caching at all" — so when the umbrella
  // is off we force every per-layer flag off too AND tell soldr to skip its
  // zccache build-cache wrapper. See zccache#307 / zackees/setup-soldr#118
  // follow-up.
  const cacheUmbrellaEnabled = !isFalsy(inputs.cache.trim() || "true");

  const explicitTargetCacheInput = inputs.targetCache.trim();
  const targetCacheInputRaw =
    explicitTargetCacheInput ||
    (legacyTargetCacheMode && legacyTargetCacheMode !== "off" ? "true" : "false");
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
    targetCachePrefix = `setup-soldr-targetcache-${buildCacheMode}-v2-${runnerOs}-${runnerArch}-${targetCachePolicyKey}`;
    const sf = sanitizedSuffix ? `${sanitizedSuffix}-` : "";
    targetCacheLockPrefix = `${targetCachePrefix}-${digest}-${cargoLockHash}-${targetShapeHash}-${sf}`;
    targetCacheLockfilePrefix = `${targetCachePrefix}-${lockfileOnlyHash}-${sf}`;
    targetCacheKey = `${targetCacheLockPrefix}${githubSha}`;
    targetCacheParentKey = parentSha ? `${targetCacheLockPrefix}${parentSha}` : "";
  } else {
    targetCachePaths = targetCacheBundlePath;
    targetCacheEffectiveMode = buildCacheMode;
    targetCachePrefix = `setup-soldr-targetcache-${buildCacheMode}-v2-${runnerOs}-${runnerArch}-${targetCachePolicyKey}`;
    const sf = sanitizedSuffix ? `${sanitizedSuffix}-` : "";
    targetCacheLockPrefix = `${targetCachePrefix}-${targetInputsHash}-${sf}`;
    targetCacheLockfilePrefix = `${targetCachePrefix}-${lockfileOnlyHash}-${sf}`;
    targetCacheKey = `${targetCacheLockPrefix}${githubSha}`;
    targetCacheParentKey = parentSha ? `${targetCacheLockPrefix}${parentSha}` : "";
  }

  // setup-soldr#237: the build-cache key intentionally does NOT include
  // `cache-key-suffix`. Per-job suffixes fragmented the cache and made the
  // restore-key fallback land on another job's archive (→ ~0% hits). The
  // suffix still scopes the action-managed setup-cache (`cacheKey` above) and
  // the target-cache, just not the content-addressed zccache build-cache.

  // ---- cargo registry cache ----
  // #267: when prebuild-deps includes `soldr-cook` AND the user (or a
  // preset they're using) has NOT explicitly set cargo-registry-cache,
  // default it to `true`. Cook restores `target/` build artifacts but
  // does NOT restore `$CARGO_HOME/registry`, so cargo re-downloads every
  // crate source on the next build — the "I set cook, why is it still
  // downloading?" trap. Presets that explicitly set
  // `cargoRegistryCache: "false"` (minimal, foundation) survive because
  // `inputs.cargoRegistryCache` is non-empty after `fillFromPreset`
  // runs; the `||` short-circuits before reaching the implicit default.
  const cookPrebuildEnabled = inputs.prebuildDeps.trim().includes("soldr-cook");
  const cargoRegistryDefault = cookPrebuildEnabled ? "true" : "false";
  const cargoRegistryCacheRawInput = inputs.cargoRegistryCache.trim();
  const cargoRegistryCachePaired =
    cookPrebuildEnabled && cargoRegistryCacheRawInput === "";
  if (cargoRegistryCachePaired) {
    log(
      "setup-soldr: defaulting cargo-registry-cache=true because prebuild-deps=soldr-cook " +
        "(see setup-soldr#267 — pairs to avoid re-downloading every crate source on next " +
        "build). Set cargo-registry-cache=false explicitly to opt out.",
    );
  }
  const cargoRegistryCacheRequested = isTruthy(
    cargoRegistryCacheRawInput || cargoRegistryDefault,
  );
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
  // #371: drop git SHA from the exact key, same anti-pattern fix as
  // #237 did for build-cache. With SHA, every commit produced a new
  // exact-key entry that no future probe could ever hit (only same-
  // commit retries). The restore-key prefix (sans SHA) already does
  // the actual work via FALLBACK — observed in production. Dropping
  // SHA lifts exact-key hit rate from ~0% toward ~100% per
  // (lockHash, digest) generation, eliminates redundant ~56 MB
  // saves per run, and reduces cache-budget churn.
  //
  // #375: also drop per-job suffix from cargo-registry. Unlike
  // build-cache (#237 KEPT suffix because target/ content differs
  // per job), cargo-registry content is just `$CARGO_HOME/registry/`
  // — downloaded crate sources keyed on Cargo.lock, identical
  // across (check, test, doc, msrv) matrix jobs. Per-job suffix
  // means N redundant saves per CI cycle (~56 MB × N for zccache's
  // 9-job matrix = ~500 MB wasted bandwidth). Sharing the key
  // across jobs means: first job saves, rest exact-HIT.
  const cargoRegistryCacheKey = `${cargoRegistryCacheRestorePrefix}${digest}`;
  const cargoRegistryCacheEnabled = cacheUmbrellaEnabled && cargoRegistryCacheRequested;
  if (cargoRegistryCacheEnabled) {
    makeDirs(cargoRegistryCachePath);
  }

  // ---- Dylint tool/driver cache (explicit opt-in, setup-soldr#221) ----
  const dylintFoundationRequested = dylintModeEnabled
    ? parseOptInBool("dylint-foundation-cache", inputs.dylintFoundationCache, true)
    : parseOptInBool("dylint-cache", inputs.dylintCache, false);
  const dylintOutputCacheEnabled =
    dylintModeEnabled &&
    cacheUmbrellaEnabled &&
    parseOptInBool("dylint-output-cache", inputs.dylintOutputCache, true);
  if (dylintOutputCacheEnabled && targetTreeCacheEnabled) {
    throw new Error(
      "dylint-output-cache cannot overlap build-cache-mode=full target caching; " +
        "disable target-cache/full mode for Dylint jobs",
    );
  }
  const dylintCacheEnabled = cacheUmbrellaEnabled && dylintFoundationRequested;
  const dylintDriverPath = path.join(runnerTemp, "dylint-drivers");
  const dylintHostTriple = rustHostTriple(ctx.runnerOs || env["ACTION_OS"] || process.platform, ctx.runnerArch || env["ACTION_ARCH"] || process.arch);
  const nightlyIdentity = dylintModeEnabled
    ? await timeSubPhase("resolve", "dylint-nightly-map", () =>
        (deps?.resolveDylintNightly ?? resolveDylintNightly)(
          inputs.dylintToolchain.trim() || toolchain.channel,
          env,
        ),
      )
    : null;
  const dylintToolchain =
    nightlyIdentity?.channel || inputs.dylintToolchain.trim() || toolchain.channel;
  const dylintRustcRelease = nightlyIdentity?.rustcRelease || "unmapped";
  const dylintRustcCommitHash = nightlyIdentity?.rustcCommitHash || "unmapped";
  const dylintCacheIdentity = `${dylintToolchain}|${dylintRustcRelease}|${dylintRustcCommitHash}`;
  const dylintRequiredComponents = ["rustc-dev", "rust-src", "llvm-tools-preview"];
  const dylintFoundationRevision = "foundation-v2";
  const dylintRunScope =
    [
      env["GITHUB_RUN_ID"],
      env["GITHUB_RUN_ATTEMPT"],
      env["GITHUB_JOB"],
      env["GITHUB_ACTION"],
    ]
      .filter(Boolean)
      .join("|") || `local-${process.pid}`;
  const dylintSuccessMarker = path.join(
    runnerTemp,
    "dylint-foundation-success",
    shortJsonHash({
      identity: dylintCacheIdentity,
      components: dylintRequiredComponents,
      revision: dylintFoundationRevision,
      runScope: dylintRunScope,
    }),
    "success.txt",
  );
  const dylintDriverRev = inputs.dylintDriverRev.trim() || "none";
  const cargoDylintVersion = inputs.cargoDylintVersion.trim() || "6.0.1";
  const dylintLinkVersion = inputs.dylintLinkVersion.trim() || "6.0.1";
  const customDylintPaths = splitPathInput(inputs.dylintCachePaths).map((p) =>
    path.isAbsolute(expanduser(p, env)) ? resolveAbsolute(p, env) : path.resolve(workspace, p),
  );
  const dylintToolchainPath = path.join(
    rustupHome,
    "toolchains",
    `${dylintToolchain}-${dylintHostTriple}`,
  );
  const dylintUpdateHashPath = path.join(
    rustupHome,
    "update-hashes",
    `${dylintToolchain}-${dylintHostTriple}`,
  );
  const dylintCachePaths =
    customDylintPaths.length > 0
      ? customDylintPaths
      : [
          ...defaultDylintCachePaths(cargoHome, dylintDriverPath),
          ...(dylintModeEnabled ? [dylintToolchainPath, dylintUpdateHashPath] : []),
        ];
  const dylintCacheHash = dylintModeEnabled
    ? shortJsonHash({
        host_triple: dylintHostTriple,
        cargo_dylint_version: cargoDylintVersion,
        dylint_link_version: dylintLinkVersion,
        dylint_toolchain: dylintToolchain,
        dylint_rustc_release: dylintRustcRelease,
        dylint_rustc_commit_hash: dylintRustcCommitHash,
        dylint_driver_rev: dylintDriverRev,
        required_components: dylintRequiredComponents,
        foundation_revision: dylintFoundationRevision,
      })
    : shortJsonHash({
        host_triple: dylintHostTriple,
        cargo_dylint_version: cargoDylintVersion,
        dylint_link_version: dylintLinkVersion,
        dylint_toolchain: dylintToolchain,
        dylint_driver_rev: dylintDriverRev,
        cargo_config: cargoConfigHashValue,
        cargo_lock: cargoLockHash,
        manifest: wsManifestHash,
        setup_toolchain: digest,
      });
  const dylintCacheSchema = dylintModeEnabled ? "v2" : "v1";
  let dylintCacheKey = `setup-soldr-dylint-${dylintCacheSchema}-${runnerOs}-${runnerArch}-${sanitizeFragment(dylintHostTriple)}-${dylintCacheHash}`;
  if (suffix) {
    dylintCacheKey = `${dylintCacheKey}-${sanitizedSuffix}`;
  }
  const dylintOutputPaths = [
    path.join(targetCachePath, "dylint", "libraries", dylintToolchain, "release"),
    path.join(targetCachePath, "dylint", "target", dylintToolchain),
  ];
  const dylintOutputHash = shortJsonHash({
    compiler_identity: dylintCacheIdentity,
    driver_revision: dylintDriverRev,
    cargo_config: cargoConfigHashValue,
    cargo_lock: cargoLockHash,
    manifests: wsManifestHash,
    target_shape: targetShapeHash,
    source_revision: githubSha,
    cache_suffix: sanitizedSuffix,
  });
  const dylintOutputKey = `setup-soldr-dylint-output-v1-${runnerOs}-${runnerArch}-${dylintOutputHash}`;
  if (dylintCacheEnabled) {
    makeDirs(dylintDriverPath);
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
  // soldr#807: warn when SOLDR_ZCCACHE_PRIVATE is truthy because the
  // explicit ZCCACHE_CACHE_DIR above will silently win and the opt-in
  // private-session path under <cwd>/.zccache won't be used.
  const zccachePrivateOverlap = detectZccachePrivateOverlap(env);
  if (zccachePrivateOverlap) core.warning(zccachePrivateOverlap);
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
  if (!soldrRef && semverAtLeast(soldrVersionResolved || soldrVersionRequested, "0.7.43")) {
    setEnv("SOLDR_CARGO_CHEF_LOCAL_DIR", binDir);
  }
  if (dylintCacheEnabled) {
    setEnv("DYLINT_DRIVER_PATH", dylintDriverPath);
    setEnv("SETUP_SOLDR_DYLINT_CACHE_KEY", dylintCacheKey);
    setEnv("SETUP_SOLDR_DYLINT_CACHE_PATHS", dylintCachePaths.join(path.delimiter));
  }
  if (dylintModeEnabled && nightlyIdentity) {
    // These are configuration hints, not the active nested-Dylint scope.
    // Soldr copies them to SOLDR_DYLINT_* only while launching cargo-dylint,
    // so an ordinary stable `soldr cargo build` later in the job is unchanged.
    setEnv("SOLDR_DYLINT_CONFIGURED_TOOLCHAIN", nightlyIdentity.channel);
    setEnv("SOLDR_DYLINT_CONFIGURED_RUSTC_RELEASE", nightlyIdentity.rustcRelease);
    setEnv("SOLDR_DYLINT_CONFIGURED_RUSTC_COMMIT_HASH", nightlyIdentity.rustcCommitHash);
    setEnv("SOLDR_DYLINT_SUCCESS_MARKER", dylintSuccessMarker);
  }
  setEnv("SOLDR_TARGET_CACHE_BACKEND", "local");
  setEnv("SETUP_SOLDR_TOOLCHAIN_CHANNEL", toolchain.channel);
  setEnv("SETUP_SOLDR_TOOLCHAIN_CACHE_CHANNEL", toolchain.cacheChannel);
  setEnv("SETUP_SOLDR_TOOLCHAIN_PROFILE", toolchain.profile);
  setEnv("SETUP_SOLDR_TOOLCHAIN_COMPONENTS", JSON.stringify(toolchain.components));
  setEnv("SETUP_SOLDR_TOOLCHAIN_TARGETS", JSON.stringify(toolchain.targets));
  setEnv("SETUP_SOLDR_LOG_START_EPOCH", logStart);
  setEnv("SETUP_SOLDR_TIMESTAMPS", timestamps);
  setEnv("SETUP_SOLDR_TIMESTAMP_FORMAT", timestampFormat);
  if (cacheEncryptKeyRaw) {
    // #387 Feature 1: propagate to GITHUB_ENV so the post-step (which loads
    // a fresh process) and any subsequent setup-soldr-using steps see the
    // same key. The key has already been core.setSecret-marked above so
    // GitHub Actions auto-redacts it from logs.
    setEnv("SETUP_SOLDR_CACHE_ENCRYPT_KEY", cacheEncryptKeyRaw);
    setEnv("SETUP_SOLDR_CACHE_ENCRYPT_ON_FAILURE", cacheEncryptOnFailure);
  }

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
  if (dylintCacheEnabled) {
    log(`dylint-cache key=${dylintCacheKey}`);
    log(`dylint-cache host-triple=${dylintHostTriple}`);
    log(`dylint-cache toolchain=${dylintToolchain}`);
    log(`dylint-cache cargo-dylint-version=${cargoDylintVersion}`);
    log(`dylint-cache dylint-link-version=${dylintLinkVersion}`);
    log(`dylint-cache driver-rev=${dylintDriverRev}`);
    log(`dylint-cache driver-path=${dylintDriverPath}`);
  }

  // ---- assemble plans ----
  const setupCache: SetupCachePlan = {
    key: cacheKey,
    restorePrefix: `${cachePrefix}-`,
    paths: setupCachePathsList ? setupCachePathsList.split("\n") : [],
    setupCachePath,
    layout: setupCacheLayoutValue,
  };
  const buildCache: BuildCachePlan = {
    enabled: buildCacheEnabled,
    key: buildCacheKey,
    restoreKeyParent: buildCacheParentKey,
    // setup-soldr#237: job-scoped fallback only — newest entry for THIS job at
    // any Cargo.lock, never another job's store. The old bare toolchain/os-arch
    // restore-keys matched any job and caused cross-job restores → 0 hits.
    restoreKeyToolchain: buildCacheJobPrefix,
    restoreKeyOsArch: "",
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
  const dylintCachePlan = {
    enabled: dylintCacheEnabled,
    outputCacheEnabled: dylintOutputCacheEnabled,
    outputKey: dylintOutputCacheEnabled ? dylintOutputKey : "",
    outputPaths: dylintOutputCacheEnabled ? dylintOutputPaths : [],
    key: dylintCacheEnabled ? dylintCacheKey : "",
    paths: dylintCacheEnabled ? dylintCachePaths : [],
    driverPath: dylintCacheEnabled ? dylintDriverPath : "",
    hostTriple: dylintCacheEnabled ? dylintHostTriple : "",
    toolchain: dylintModeEnabled || dylintCacheEnabled ? dylintToolchain : "",
    rustcRelease: dylintModeEnabled ? dylintRustcRelease : "",
    rustcCommitHash: dylintModeEnabled ? dylintRustcCommitHash : "",
    cacheIdentity: dylintModeEnabled ? dylintCacheIdentity : "",
    successMarker: dylintModeEnabled ? dylintSuccessMarker : "",
    driverRev: dylintCacheEnabled ? dylintDriverRev : "",
    cargoDylintVersion: dylintCacheEnabled ? cargoDylintVersion : "",
    dylintLinkVersion: dylintCacheEnabled ? dylintLinkVersion : "",
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
    dylintCache: dylintCachePlan,
    crossToolCaches: crossToolCachePlans,
    targetCacheCompress,
    targetCacheCompressLevel,
    envExports,
    pathAdditions,
    logStartEpoch: logStart,
    timestamps,
    timestampFormat,
    shimsEnabled,
    shimsDir,
    compileCacheStats,
    stats,
    debugMode,
    cacheShutdownOnIdleSeconds,
    cachePresetEffective,
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
