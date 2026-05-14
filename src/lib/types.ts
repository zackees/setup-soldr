// Shared types for setup-soldr.
//
// This module defines the API surface that the three parallel implementation
// agents share. It is the contract — every exported function in src/lib/*
// uses these types, and src/main.ts wires them together.
//
// Mirror of the GitHub Actions inputs/outputs declared in action.yml.

export type Bool = "true" | "false";
export type CompressCodec = "auto" | "zstd" | "none";
export type BuildCacheMode = "" | "once" | "thin" | "full";
export type TargetCacheMode = "" | "thin" | "full" | "off" | "hot";
export type TargetCacheProfile = "thin-v1" | "thin-v2";
export type StatsMode = "none" | "summarize" | "detailed";

export interface CacheOpStats {
  label: string;
  operation: "restore" | "save";
  hit: boolean;
  key: string;
  matchedKey: string;
  restoreKeys: string[];
  archiveBytes: number | null;
  inflatedBytes: number | null;
  fileCount: number | null;
  durationMs: number;
  timestamp: string;
}

/**
 * Raw INPUT_* env vars read at process start. Mirrors `inputs:` in action.yml.
 * Values are strings (GitHub Actions inputs are always strings); normalize
 * inside the resolve layer.
 */
export interface RawInputs {
  version: string;
  repo: string;
  ref: string;
  cache: string;
  cacheDir: string;
  cacheKeySuffix: string;
  toolchain: string;
  toolchainFile: string;
  trustMode: string;
  linker: string;
  compilePriority: string;
  timestamps: string;
  lockfile: string;
  buildCache: string;
  buildCacheMode: string;
  targetCache: string;
  targetCacheMode: string;
  targetDir: string;
  targetCacheProfile: string;
  targetCacheStripDebuginfo: string;
  targetCacheIncludeIncremental: string;
  targetCacheIncludeBuildScriptBinaries: string;
  targetCacheCompress: string;
  targetCacheCompressLevel: string;
  sourceMtimeNormalize: string;
  cargoRegistryCache: string;
  shims: string;
  stats: string;
  debugMode: string;
}

/**
 * Toolchain spec resolved from rust-toolchain.toml (or input override).
 * Equivalent of resolve_setup.load_toolchain_spec() in Python.
 */
export interface ToolchainSpec {
  channel: string;
  cacheChannel: string;
  profile: string;
  components: string[];
  targets: string[];
  source: string;
  fileHash: string;
}

/**
 * Setup-cache key plan (the action-owned cache holding soldr binary + rustup state).
 */
export interface SetupCachePlan {
  key: string;
  restorePrefix: string;
  paths: string[];
  setupCachePath: string;
  layout: "bin+soldr-bin" | "bin+soldr-bin+rustup";
}

/**
 * Build-cache key plan (zccache compilation cache).
 */
export interface BuildCachePlan {
  key: string;
  restoreKeyParent: string;
  restoreKeyToolchain: string;
  restoreKeyOsArch: string;
  path: string;
  mode: "once" | "thin" | "full";
}

/**
 * Target-cache key plan (zccache rust-plan bundle + optional full target/ tree).
 */
export interface TargetCachePlan {
  enabled: boolean;
  key: string;
  restoreKeyParent: string;
  restoreKeyLock: string;
  restoreKeyLockfile: string;
  paths: string;
  bundlePath: string;
  targetPath: string;
  effectiveMode: "once" | "thin" | "full" | "off";
  profile: TargetCacheProfile;
  budgetBytes: string;
  budgetFiles: string;
  lockfilePath: string;
  lockfileHash: string;
}

/**
 * Cargo-registry cache plan (payload C of issue #70).
 */
export interface CargoRegistryCachePlan {
  enabled: boolean;
  key: string;
  restorePrefix: string;
  path: string;
}

/**
 * Full resolved state from resolve-setup. Drives every downstream step.
 *
 * This is the single source of truth produced by resolveSetup() and consumed
 * by the orchestrator + every helper. Mirrors the output set written to
 * $GITHUB_OUTPUT by Python's resolve_setup.py.
 */
export interface ResolveResult {
  // Roots
  workspace: string;
  cacheRoot: string;
  soldrRoot: string;
  binDir: string;
  cargoHome: string;
  rustupHome: string;
  soldrPath: string;
  soldrBinCachePath: string;

  // Toolchain
  toolchain: ToolchainSpec;
  rustupStrategy: "managed" | "system" | "explicit";

  // Soldr
  soldrRepo: string;
  soldrRef: string;
  soldrVersionRequested: string;
  soldrVersionResolved: string;

  // Cache plans
  setupCache: SetupCachePlan;
  buildCache: BuildCachePlan;
  targetCache: TargetCachePlan;
  cargoRegistryCache: CargoRegistryCachePlan;

  // Compression
  targetCacheCompress: CompressCodec;
  targetCacheCompressLevel: string;

  // Env exports (written to $GITHUB_ENV by the orchestrator)
  envExports: Record<string, string>;

  // PATH additions (written to $GITHUB_PATH by the orchestrator)
  pathAdditions: string[];

  // Timing
  logStartEpoch: string;
  timestamps: string;

  // Shims
  shimsEnabled: boolean;
  shimsDir: string;

  // Stats and debug
  stats: StatsMode;
  debugMode: boolean;
}

/**
 * Cache restore result. Returned by @actions/cache restore wrappers.
 */
export interface CacheRestoreResult {
  cacheHit: boolean;
  matchedKey: string;
}

/**
 * Phase timing record. Persisted via env var SETUP_SOLDR_PHASE_{NAME}_START_MS.
 */
export interface PhaseMark {
  phase: string;
  startMs: number;
}

/**
 * Phase timing finish result.
 */
export interface PhaseDuration {
  phase: string;
  seconds: number;
}

/**
 * Logger interface. Helpers receive an instance so they can be tested without
 * touching @actions/core directly.
 */
export interface Logger {
  info(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  log(msg: string): void; // setup-soldr's timestamped "log" — equivalent to Python's log()
}

/**
 * Action-runtime context. Injected into every helper for testability.
 * In production, fields default to wrappers around @actions/* modules and process.env.
 */
export interface ActionContext {
  env: Record<string, string | undefined>;
  workspace: string;
  runnerTemp: string;
  runnerOs: string;
  runnerArch: string;
  githubSha: string;
  githubToken: string;
  parentSha: string;
  logger: Logger;
}
