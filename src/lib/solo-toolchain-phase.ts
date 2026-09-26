// Main-step toolchain phase with the solo toolchain cache (#525).
//
// Replaces the snapshot-pre/base/post walks of $RUSTUP_HOME/toolchains and
// $CARGO_HOME/bin. setup-soldr already knows the one directory it installs,
// `toolchains/<channel>-<host>`, so:
//
//   1. disabled (`solo-toolchain-cache: false` or `cache: false`): install,
//      nothing else — no stat, no lookup, no save (T7/T8).
//   2. one stat of `toolchains/<channel>-<host>`: present before we did
//      anything → the runner image or setup-cache provides it; install
//      (a no-op top-up) and never look up or save (T5).
//   3. restore by key; an exact, verified hit skips install and save (T4).
//   4. otherwise install, then SEAL the toolchain directory (plus the rustup
//      proxies the install added) into a private copy right away, before any
//      job step runs, and start the background upload of that copy (#507).
//
// The post step only waits for that upload (`finalizeSoloToolchainSave`).

import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { timeSubPhase as timePhaseSubPhase } from "./phase-timing.js";
import {
  buildSoloCacheKeys,
  defaultSoloFs,
  detectLibc,
  hashStringArray,
  restoreSoloCache,
  rustHostTriple,
  sealToolchainForSave,
  soloCacheArchivePath,
  soloKeyNamespaceFromEnv,
  soloPathExists,
  toolchainDirName,
  verifyListedTargetStd,
  verifyRestoredToolchain,
  type SealToolchainResult,
  type SoloFs,
} from "./solo-toolchain-cache.js";
import { startSoloToolchainUpload, type SoloUploadConfig } from "./solo-toolchain-upload.js";
import type { CacheOpStats } from "./types.js";

/** State keys shared between the main step (this file) and the post step. */
export const SOLO_STATE = {
  enabled: "soloToolchainEnabled",
  outcome: "soloToolchainOutcome",
  exactKey: "soloToolchainExactKey",
  matchedKey: "soloToolchainMatchedKey",
  restoreInvalid: "soloToolchainRestoreInvalid",
  invalidMatchedKey: "soloToolchainInvalidMatchedKey",
  uploadResultPath: "soloToolchainUploadResultPath",
  uploadConfigPath: "soloToolchainUploadConfigPath",
  uploadLogPath: "soloToolchainUploadLogPath",
} as const;

/** Written to RUNNER_TEMP; the probe workflow reads it for E3/E4/E7. */
export const SOLO_SUMMARY_FILENAME = "setup-soldr-solo-toolchain-summary.json";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function isTruthy(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}
function isFalsy(value: string | undefined): boolean {
  return FALSY.has((value ?? "").trim().toLowerCase());
}

/** `cache: false` is the master switch and disables this layer too (#507 item 4). */
export function soloToolchainCacheEnabled(inputs: { soloToolchainCache: string; cache: string }): boolean {
  return isTruthy(inputs.soloToolchainCache) && !isFalsy(inputs.cache.trim() || "true");
}

export type SoloPhaseOutcome =
  | "disabled"
  | "unsupported-host"
  | "image-provided"
  | "exact-hit"
  | "sealed"
  | "seal-failed";

type StartUpload = (config: SoloUploadConfig) => Promise<{
  configPath: string;
  resultPath: string;
  logPath: string;
  pid: number | null;
  spawnedAtMs: number;
}>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runSoloToolchainPhase(opts: {
  enabled: boolean;
  rustupHome: string;
  cargoHome: string;
  runnerTemp: string;
  channel: string;
  release: string;
  components: string[];
  targets: string[];
  runnerOs: string;
  runnerArch: string;
  platform?: string;
  libc?: string;
  namespace?: string;
  level: string;
  debug: boolean;
  entrypoint?: string;
  deps: {
    install: (forceRepair: boolean) => Promise<void>;
    verifyRustup?: () => Promise<boolean>;
    restore?: typeof restoreSoloCache;
    seal?: typeof sealToolchainForSave;
    startUpload?: StartUpload;
    fs?: SoloFs;
    timeSubPhase?: <T>(name: string, body: () => Promise<T>) => Promise<T>;
    saveState?: (k: string, v: string) => void;
    log?: (m: string) => void;
    warn?: (m: string) => void;
    exportToolchain?: (channel: string) => void;
    recordRestore?: (op: CacheOpStats) => void;
  };
}): Promise<{
  outcome: SoloPhaseOutcome;
  key: string;
  matchedKey: string;
  toolchainDir: string;
  restoreInvalid: boolean;
}> {
  const { deps, rustupHome, cargoHome, runnerTemp, channel, release, components, targets } = opts;
  const timeSubPhase: <T>(name: string, body: () => Promise<T>) => Promise<T> = deps.timeSubPhase ??
    (<T>(name: string, body: () => Promise<T>): Promise<T> => timePhaseSubPhase<T>("toolchain", name, body));
  const saveState = deps.saveState ?? ((k: string, v: string): void => core.saveState(k, v));
  const log = deps.log ?? ((m: string): void => core.info(m));
  const warn = deps.warn ?? ((m: string): void => core.warning(m));
  const recordRestore = deps.recordRestore ?? ((): void => undefined);
  const exportToolchain = deps.exportToolchain ?? ((ch: string): void => {
    core.exportVariable("RUSTUP_TOOLCHAIN", ch);
    process.env["RUSTUP_TOOLCHAIN"] = ch;
  });

  const writeSummary = (summary: Record<string, unknown>): void => {
    if (!runnerTemp) return;
    const summaryPath = path.join(runnerTemp, SOLO_SUMMARY_FILENAME);
    try {
      fs.mkdirSync(runnerTemp, { recursive: true });
      fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    } catch (err) {
      log(`solo-toolchain-cache: summary write failed: ${errorMessage(err)}`);
    }
  };

  // 1. Disabled: the install is the whole phase. No filesystem probe of
  //    $RUSTUP_HOME, no cache lookup, no save (T7/T8, E7).
  if (!opts.enabled || !runnerTemp) {
    await timeSubPhase("rustup-install", () => deps.install(false));
    saveState(SOLO_STATE.enabled, "false");
    saveState(SOLO_STATE.outcome, "disabled");
    saveState(SOLO_STATE.restoreInvalid, "false");
    writeSummary({ schema: 1, enabled: false, outcome: "disabled" });
    return { outcome: "disabled", key: "", matchedKey: "", toolchainDir: "", restoreInvalid: false };
  }

  const soloFs = deps.fs ?? defaultSoloFs;
  const platform = opts.platform ?? process.platform;
  const libc = opts.libc ?? detectLibc();
  const namespace = opts.namespace ?? soloKeyNamespaceFromEnv();

  let outcome: SoloPhaseOutcome = "disabled";
  let key = "";
  let matchedKey = "";
  let toolchainDir = "";
  let toolchainPath = "";
  let existedBefore = false;
  let restoreDownloadMs: number | null = null;
  let restoreInvalid = false;
  let sealed: SealToolchainResult | null = null;
  let proxyNames: string[] = [];
  let upload: { configPath: string; resultPath: string; logPath: string; pid: number | null; spawnedAtMs: number } | null =
    null;

  const finish = (): {
    outcome: SoloPhaseOutcome;
    key: string;
    matchedKey: string;
    toolchainDir: string;
    restoreInvalid: boolean;
  } => {
    saveState(SOLO_STATE.enabled, "true");
    saveState(SOLO_STATE.outcome, outcome);
    saveState(SOLO_STATE.exactKey, key);
    saveState(SOLO_STATE.matchedKey, matchedKey);
    saveState(SOLO_STATE.restoreInvalid, restoreInvalid ? "true" : "false");
    saveState(SOLO_STATE.invalidMatchedKey, restoreInvalid ? matchedKey : "");
    if (upload) {
      saveState(SOLO_STATE.uploadResultPath, upload.resultPath);
      saveState(SOLO_STATE.uploadConfigPath, upload.configPath);
      saveState(SOLO_STATE.uploadLogPath, upload.logPath);
    }
    writeSummary({
      schema: 1,
      enabled: true,
      outcome,
      key,
      matchedKey,
      toolchainDir,
      toolchainPath,
      existedBefore,
      restoreInvalid,
      restoreDownloadMs,
      sealed: sealed
        ? {
          files: sealed.files,
          symlinks: sealed.symlinks,
          directories: sealed.directories,
          bytes: sealed.bytes,
          proxies: sealed.proxies,
          updateHash: sealed.updateHash,
        }
        : null,
      proxyNames,
      upload: upload
        ? { resultPath: upload.resultPath, logPath: upload.logPath, pid: upload.pid, spawnedAtMs: upload.spawnedAtMs }
        : null,
    });
    return { outcome, key, matchedKey, toolchainDir, restoreInvalid };
  };

  // 2. No rustup host triple → the directory name is unknowable; never guess.
  const host = rustHostTriple(platform, opts.runnerArch, libc);
  if (!host) {
    log(
      `solo-toolchain-cache: no rustup host triple for platform=${platform} arch=${opts.runnerArch} libc=${libc}; ` +
        `installing without the toolchain cache`,
    );
    await timeSubPhase("rustup-install", () => deps.install(false));
    outcome = "unsupported-host";
    return finish();
  }

  // 3. One stat decides "did it exist before?". Nothing else under
  //    toolchains/ is ever read.
  toolchainDir = toolchainDirName(channel, host);
  toolchainPath = path.join(rustupHome, "toolchains", toolchainDir);
  const binDir = path.join(cargoHome, "bin");
  const listProxies = async (): Promise<string[]> => {
    try {
      return (await soloFs.readdir(binDir)).map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  let proxiesBefore: string[] = [];
  let updateHashBefore = false;
  existedBefore = await timeSubPhase("solo-probe", async () => {
    const existed = await soloPathExists(toolchainPath, soloFs);
    if (existed) return true;
    proxiesBefore = await listProxies();
    updateHashBefore = await soloPathExists(path.join(rustupHome, "update-hashes", toolchainDir), soloFs);
    return false;
  });
  if (existedBefore) {
    log(
      `solo-toolchain-cache: ${toolchainDir} already present (runner image or setup cache); no lookup and no save`,
    );
    await timeSubPhase("rustup-install", () => deps.install(false));
    outcome = "image-provided";
    return finish();
  }

  // 4. Restore by key.
  const platformRustup = platform === "win32" ? "rustup.exe" : "rustup";
  const verifyRustup = deps.verifyRustup ?? (async (): Promise<boolean> => (await verifyRestoredToolchain({
    expectedRelease: release,
    expectedTargets: targets,
    expectedComponents: components,
    channel,
    rustupCommand: platformRustup,
    log,
  })).match);
  const keys = buildSoloCacheKeys({
    runnerOs: opts.runnerOs,
    runnerArch: opts.runnerArch,
    libc,
    rustcRelease: release,
    componentsHash: hashStringArray(components),
    targetsHash: hashStringArray(targets),
    namespace,
  });
  key = keys.exact;
  log(`solo-toolchain-cache: key=${keys.exact}`);
  const restoreT0 = Date.now();
  const restored = await timeSubPhase("solo-restore", () =>
    (deps.restore ?? restoreSoloCache)({
      keys,
      rustupHome,
      cargoHome,
      toolchainDir,
      stagingDir: path.join(runnerTemp, "setup-soldr-solo-cache"),
      cacheArchivePath: soloCacheArchivePath(runnerTemp),
      log,
      fs: soloFs,
    }),
  );
  matchedKey = restored.matchedKey;
  restoreDownloadMs = typeof restored.downloadMs === "number" ? restored.downloadMs : null;
  let valid = false;
  if (restored.matchedKey && restored.verified) {
    valid = await verifyRustup();
    if (valid) {
      // T6: every target rustup lists must ship its std, declared or not.
      const listed = await verifyListedTargetStd({ toolchainPath, fs: soloFs });
      if (!listed.ok) {
        log(
          `solo-toolchain-cache: restored toolchain lists targets without std: ${listed.missing.join(",")}`,
        );
      }
      valid = listed.ok;
    }
  }
  restoreInvalid = Boolean(restored.matchedKey) && !(restored.verified && valid);
  const exactHit = restored.hit && restored.verified && valid;
  recordRestore({
    label: "solo-toolchain-cache",
    operation: "restore",
    hit: exactHit,
    key: keys.exact,
    matchedKey,
    restoreKeys: keys.fallbacks,
    archiveBytes: restored.restoredBytes || null,
    inflatedBytes: null,
    fileCount: null,
    durationMs: Date.now() - restoreT0,
    timestamp: new Date().toISOString(),
  });
  if (restoreInvalid) {
    warn(
      `solo-toolchain-cache: restored entry failed validation; key=${restored.matchedKey} ` +
        `archive=${restored.restoredBytes}B. The requested toolchain and targets will be repaired, ` +
        `then the poisoned cache entry will be deleted and replaced (#473).`,
    );
  }

  // 5. Exact, verified hit: no install, no seal, no upload (#323, T4).
  if (exactHit) {
    log("toolchain: solo-cache exact-hit + verified — skipping rustup install (#323)");
    // The skipped installer is also where ensureRustToolchain normally
    // exports the selected channel. Keep cache-hit jobs explicit so rustup
    // proxies used by later probes never depend on a runner-global default.
    exportToolchain(channel);
    outcome = "exact-hit";
    return finish();
  }

  // 6. Install (or repair), then seal right away and start the upload.
  await timeSubPhase("rustup-install", () => deps.install(restoreInvalid));
  if (restoreInvalid) {
    const repaired = await verifyRustup() && (await verifyListedTargetStd({ toolchainPath, fs: soloFs })).ok;
    if (!repaired) {
      throw new Error(
        `solo-toolchain-cache: repair did not restore the requested toolchain and targets for key=${matchedKey}`,
      );
    }
    log(`solo-toolchain-cache: repaired toolchain and requested targets verified for key=${matchedKey}`);
  }
  const before = new Set(proxiesBefore);
  proxyNames = (await listProxies()).filter((name) => !before.has(name)).sort();
  try {
    await timeSubPhase("solo-seal", async () => {
      const stagingDir = path.join(runnerTemp, "setup-soldr-solo-cache", "staged");
      sealed = await (deps.seal ?? sealToolchainForSave)({
        rustupHome,
        cargoHome,
        toolchainDir,
        proxies: proxyNames,
        includeUpdateHash: !updateHashBefore,
        stagingDir,
        fs: soloFs,
      });
      const config: SoloUploadConfig = {
        stagingDir,
        key: keys.exact,
        level: opts.level,
        cacheArchivePath: soloCacheArchivePath(runnerTemp),
        debug: opts.debug,
        ...(restoreInvalid ? { repairPoisonedKey: matchedKey } : {}),
      };
      const startUpload: StartUpload = deps.startUpload ?? ((cfg) => startSoloToolchainUpload({
        config: cfg,
        workDir: path.join(runnerTemp, "setup-soldr-solo-upload"),
        entrypoint: opts.entrypoint || process.argv[1] || "",
      }));
      upload = await startUpload(config);
    });
    const s = sealed as SealToolchainResult | null;
    const u = upload as { pid: number | null } | null;
    log(
      `solo-toolchain-cache: sealed dir=${toolchainDir} files=${s?.files ?? 0} symlinks=${s?.symlinks ?? 0} ` +
        `proxies=${s?.proxies ?? 0} bytes=${s?.bytes ?? 0}; background upload started pid=${u?.pid ?? "unknown"} (#525)`,
    );
    outcome = "sealed";
  } catch (err) {
    warn(`solo-toolchain-cache: could not seal ${toolchainDir} for upload: ${errorMessage(err)}`);
    upload = null;
    outcome = "seal-failed";
  }
  return finish();
}
