// Background upload of the sealed solo toolchain archive (#525).
//
// The main step seals `toolchains/<channel>-<host>` (plus the rustup proxies
// the install added) into a private directory right after install, before any
// job step can run `rustup target add` or download a build-time `rust-std`
// (#507). This module compresses and uploads that sealed directory from a
// detached worker so the ~17 s upload stays off the job's critical path, and
// gives the post step one entry point (`finalizeSoloToolchainSave`) that only
// waits for the result. Mirrors the yank-audit detached worker (#476): config
// and result live as JSON files under RUNNER_TEMP; the token is never written
// to disk — the worker reads it from its inherited environment.
//
// The worker only ever reads the sealed directory. It never reads the live
// $RUSTUP_HOME or $CARGO_HOME, so nothing a job step does can leak into the
// archive.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  deleteCorruptSoloCacheEntries,
  saveSoloCache,
  soloCacheEntryExistsForRef,
} from "./solo-toolchain-cache.js";
import { SOLO_STATE } from "./solo-toolchain-phase.js";
import type { CacheOpStats } from "./types.js";

export const SOLO_TOOLCHAIN_UPLOAD_WORKER_ARG = "--setup-soldr-solo-toolchain-upload-worker";

/** Everything the detached worker needs. Never holds a token. */
export interface SoloUploadConfig {
  /** Sealed directory produced at install time; the only tree the worker reads. */
  stagingDir: string;
  key: string;
  level: string;
  cacheArchivePath: string;
  debug: boolean;
  /** Set when the restored entry failed validation (#473): delete it before publishing. */
  repairPoisonedKey?: string;
}

export type SoloUploadStatus =
  | "pending"
  | "uploading"
  | "saved"
  | "race-precheck-skipped"
  | "failed"
  | "worker-died"
  | "timeout";

export interface SoloUploadResult {
  status: SoloUploadStatus;
  spawnedAtMs: number;
  pid?: number | null;
  startedAtMs?: number;
  finishedAtMs?: number;
  cacheId?: number;
  archiveBytes?: number;
  inflatedBytes?: number;
  fileCount?: number;
  error?: string;
  repairDeletion?: { found: number; deleted: number; failed: number };
}

type SaveOpts = Parameters<typeof saveSoloCache>[0];

const UPLOAD_STATUSES: readonly SoloUploadStatus[] = [
  "pending",
  "uploading",
  "saved",
  "race-precheck-skipped",
  "failed",
  "worker-died",
  "timeout",
];

const TERMINAL_STATUSES: readonly SoloUploadStatus[] = [
  "saved",
  "race-precheck-skipped",
  "failed",
  "worker-died",
  "timeout",
];

function isTerminal(status: SoloUploadStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeSoloUploadResult(resultPath: string, result: SoloUploadResult): void {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  const temporaryPath = `${resultPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(result)}\n`, "utf8");
  fs.renameSync(temporaryPath, resultPath);
}

export function readSoloUploadResult(resultPath: string): SoloUploadResult | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Partial<SoloUploadResult> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.status !== "string" || !UPLOAD_STATUSES.includes(parsed.status)) return null;
    const spawnedAtMs = typeof parsed.spawnedAtMs === "number" && Number.isFinite(parsed.spawnedAtMs)
      ? parsed.spawnedAtMs
      : 0;
    return { ...parsed, status: parsed.status, spawnedAtMs };
  } catch {
    return null;
  }
}

/**
 * Write the worker config + a `pending` result, then spawn this action's own
 * entrypoint as a detached worker (`SOLO_TOOLCHAIN_UPLOAD_WORKER_ARG`). The
 * worker's stdout and stderr both go to `worker.log` next to the result so the
 * post step can surface a tail on failure.
 */
export async function startSoloToolchainUpload(opts: {
  config: SoloUploadConfig;
  workDir: string;
  entrypoint: string;
  spawnImpl?: typeof spawn;
  now?: () => number;
}): Promise<{ configPath: string; resultPath: string; logPath: string; pid: number | null; spawnedAtMs: number }> {
  const { config, workDir, entrypoint } = opts;
  const now = opts.now ?? Date.now;
  const spawnImpl = opts.spawnImpl ?? spawn;
  if (!entrypoint) throw new Error("Node action entrypoint is unavailable");
  await fsp.mkdir(workDir, { recursive: true });
  const configPath = path.join(workDir, "config.json");
  const resultPath = path.join(workDir, "result.json");
  const logPath = path.join(workDir, "worker.log");
  await fsp.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  const spawnedAtMs = now();
  writeSoloUploadResult(resultPath, { status: "pending", spawnedAtMs });
  const logFd = fs.openSync(logPath, "w");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnImpl(
      process.execPath,
      [entrypoint, SOLO_TOOLCHAIN_UPLOAD_WORKER_ARG, configPath, resultPath],
      { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true },
    );
  } finally {
    fs.closeSync(logFd);
  }
  // A failed spawn reports asynchronously; record it instead of letting an
  // unhandled 'error' event crash the main step. The post step then sees a
  // terminal `failed` result rather than waiting on a pid that never existed.
  if (typeof child.on === "function") {
    child.on("error", (err: unknown) => {
      try {
        writeSoloUploadResult(resultPath, {
          status: "failed",
          spawnedAtMs,
          pid: null,
          finishedAtMs: now(),
          error: `worker spawn failed: ${errorMessage(err)}`,
        });
      } catch {
        // Best effort; the post step's liveness check covers this case.
      }
    });
  }
  child.unref();
  const pid = typeof child.pid === "number" ? child.pid : null;
  // The worker records its own progress; only fill in the pid while the
  // result still says pending so a fast worker's `uploading` is not clobbered.
  const current = readSoloUploadResult(resultPath);
  if (!current || current.status === "pending") {
    const pending: SoloUploadResult = current ?? { status: "pending", spawnedAtMs };
    writeSoloUploadResult(resultPath, { ...pending, pid });
  }
  return { configPath, resultPath, logPath, pid, spawnedAtMs };
}

/**
 * Compress + upload the sealed directory named in `configPath`, recording
 * progress and the terminal outcome in `resultPath`. Runs in the detached
 * worker, or in-process from the post step when the worker died. Never throws.
 */
export async function runSoloToolchainUploadWorker(
  configPath: string,
  resultPath: string,
  deps: {
    saveSoloCache?: typeof saveSoloCache;
    deleteCorrupt?: typeof deleteCorruptSoloCacheEntries;
    entryExists?: typeof soloCacheEntryExistsForRef;
    env?: NodeJS.ProcessEnv;
    log?: (m: string) => void;
    now?: () => number;
    compress?: SaveOpts["compress"];
    saveCache?: SaveOpts["saveCache"];
  } = {},
): Promise<SoloUploadResult> {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string): void => { console.log(m); });
  const existing = readSoloUploadResult(resultPath);
  const startedAtMs = now();
  const base: SoloUploadResult = {
    status: "uploading",
    spawnedAtMs: existing?.spawnedAtMs || startedAtMs,
    pid: existing?.pid ?? process.pid,
    startedAtMs,
  };
  let result: SoloUploadResult;
  try {
    writeSoloUploadResult(resultPath, base);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<SoloUploadConfig>;
    if (!config.stagingDir || !config.key || !config.cacheArchivePath) {
      throw new Error(`upload config ${configPath} is missing stagingDir, key, or cacheArchivePath`);
    }
    const stagingDir = config.stagingDir;
    const key = config.key;
    const repairKey = (config.repairPoisonedKey ?? "").trim();
    const [owner = "", repo = ""] = (env["GITHUB_REPOSITORY"] ?? "").trim().split("/");
    const token = (env["GITHUB_TOKEN"] ?? "").trim() || (env["INPUT_TOKEN"] ?? "").trim();
    const ref = (env["GITHUB_REF"] ?? "").trim();
    log(`solo-toolchain-cache: upload worker key=${key} level=${config.level ?? "9"} repair=${repairKey || "none"}`);

    let repairDeletion: SoloUploadResult["repairDeletion"];
    let repairDeletionComplete = false;
    if (repairKey) {
      const deletion = await (deps.deleteCorrupt ?? deleteCorruptSoloCacheEntries)({
        owner,
        repo,
        token,
        key: repairKey,
        ref,
        log,
      });
      repairDeletion = { found: deletion.found, deleted: deletion.deleted, failed: deletion.failed };
      repairDeletionComplete = deletion.failed === 0 && deletion.deleted === deletion.found;
      if (!repairDeletionComplete) {
        log(
          `solo-toolchain-cache: could not fully delete poisoned key=${repairKey}; ` +
            `found=${deletion.found} deleted=${deletion.deleted} failed=${deletion.failed}`,
        );
      }
    }

    const entryExists = deps.entryExists ?? soloCacheEntryExistsForRef;
    const save = await (deps.saveSoloCache ?? saveSoloCache)({
      stagingDir,
      key,
      level: config.level || "9",
      debug: Boolean(config.debug),
      log,
      cacheArchivePath: config.cacheArchivePath,
      // A validated-bad entry was just deleted; a stale listing must not
      // suppress the verified replacement (#473).
      skipExistingProbe: Boolean(repairKey),
      lookupExactKey: repairKey && repairDeletionComplete
        ? async () => (await entryExists({ owner, repo, token, key, ref, log })) ? key : undefined
        : undefined,
      compress: deps.compress,
      saveCache: deps.saveCache,
    });
    const finishedAtMs = now();
    if (save.status === "saved" || save.status === "race-precheck-skipped") {
      result = {
        ...base,
        status: save.status,
        finishedAtMs,
        ...(save.cacheId !== undefined ? { cacheId: save.cacheId } : {}),
        ...(save.archiveBytes !== undefined ? { archiveBytes: save.archiveBytes } : {}),
        ...(save.inflatedBytes !== undefined ? { inflatedBytes: save.inflatedBytes } : {}),
        ...(save.fileCount !== undefined ? { fileCount: save.fileCount } : {}),
        ...(repairDeletion ? { repairDeletion } : {}),
      };
    } else {
      result = {
        ...base,
        status: "failed",
        finishedAtMs,
        error: `${save.status}${save.error ? `: ${save.error}` : ""}`,
        ...(repairDeletion ? { repairDeletion } : {}),
      };
    }
  } catch (err) {
    result = { ...base, status: "failed", finishedAtMs: now(), error: errorMessage(err) };
  }
  log(`solo-toolchain-cache: upload worker finished status=${result.status}${result.error ? ` error=${result.error}` : ""}`);
  try {
    writeSoloUploadResult(resultPath, result);
  } catch (err) {
    log(`solo-toolchain-cache: failed to record upload result: ${errorMessage(err)}`);
  }
  return result;
}

/**
 * True when `/proc/<pid>/stat` reports a zombie (or dead) process. A detached
 * worker in a container job is reparented to the container's PID 1, which on
 * GitHub's `tail -f /dev/null` entrypoint never reaps it: `kill(pid, 0)` keeps
 * succeeding after the worker has exited. Linux only; elsewhere returns false.
 */
export function isZombieProcess(pid: number, readStat?: (p: string) => string): boolean {
  if (!readStat && process.platform !== "linux") return false;
  try {
    const stat = (readStat ?? ((p: string) => fs.readFileSync(p, "utf8")))(`/proc/${pid}/stat`);
    // Format: `<pid> (<comm>) <state> ...`; comm may contain spaces or `)`.
    const close = stat.lastIndexOf(")");
    if (close < 0) return false;
    const state = stat.slice(close + 1).trim().charAt(0);
    return state === "Z" || state === "X";
  } catch {
    return false;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  return !isZombieProcess(pid);
}

/**
 * Wait for the background upload to reach a terminal status. When the worker
 * is gone while the result still says pending/uploading (two consecutive
 * dead polls), run the upload in-process from the SAME sealed directory — the
 * live toolchain roots are never re-read.
 */
export async function awaitSoloToolchainUpload(opts: {
  resultPath: string;
  configPath: string;
  timeoutMs?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  runInProcess?: () => Promise<SoloUploadResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}): Promise<SoloUploadResult> {
  const { resultPath, configPath } = opts;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 500;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const runInProcess = opts.runInProcess ?? (() => runSoloToolchainUploadWorker(configPath, resultPath));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => undefined);
  const deadline = now() + timeoutMs;
  let last: SoloUploadResult | null = null;
  let deadPolls = 0;
  while (true) {
    const current = readSoloUploadResult(resultPath);
    if (current) last = current;
    if (current && isTerminal(current.status)) return current;
    const pid = current?.pid;
    const alive = typeof pid === "number" && pid > 0 && isAlive(pid);
    deadPolls = alive ? 0 : deadPolls + 1;
    if (deadPolls >= 2) {
      log(
        `solo-toolchain-cache: upload worker pid=${pid ?? "unknown"} is gone with status=${current?.status ?? "missing"}; ` +
          `uploading the sealed toolchain in-process`,
      );
      try {
        return await runInProcess();
      } catch (err) {
        return {
          ...(last ?? { spawnedAtMs: 0 }),
          status: "worker-died",
          finishedAtMs: now(),
          error: errorMessage(err),
        };
      }
    }
    if (now() >= deadline) {
      return { ...(last ?? { spawnedAtMs: 0 }), status: "timeout" };
    }
    await sleep(pollMs);
  }
}

/**
 * The only solo-toolchain logic the post step runs: wait for the upload that
 * the main step started from the install-time seal, record it, and enforce
 * the #473 repair contract. Never touches live toolchain directories.
 */
export async function finalizeSoloToolchainSave(opts: {
  getState: (k: string) => string;
  log: (m: string) => void;
  warn: (m: string) => void;
  setFailed: (m: string) => void;
  record: (op: CacheOpStats) => void;
  awaitUpload?: typeof awaitSoloToolchainUpload;
  readLog?: (p: string) => string;
}): Promise<{ status: string }> {
  const { getState, log, warn, setFailed, record } = opts;
  if (getState(SOLO_STATE.enabled) !== "true") return { status: "disabled" };
  const outcome = getState(SOLO_STATE.outcome) || "unknown";
  const restoreInvalid = getState(SOLO_STATE.restoreInvalid) === "true";
  const invalidMatchedKey = getState(SOLO_STATE.invalidMatchedKey);
  const resultPath = getState(SOLO_STATE.uploadResultPath);
  if (outcome !== "sealed" || !resultPath) {
    log(`solo-toolchain-cache: outcome=${outcome}; nothing to upload`);
    if (restoreInvalid) {
      setFailed("solo-toolchain-cache: repaired a poisoned restore but sealed no replacement (#473)");
    }
    return { status: `skipped-${outcome}` };
  }
  const key = getState(SOLO_STATE.exactKey);
  const matchedKey = getState(SOLO_STATE.matchedKey);
  const configPath = getState(SOLO_STATE.uploadConfigPath);
  const logPath = getState(SOLO_STATE.uploadLogPath);
  const upload = await (opts.awaitUpload ?? awaitSoloToolchainUpload)({ resultPath, configPath, log });
  const saved = upload.status === "saved";
  record({
    label: "solo-toolchain-cache",
    operation: "save",
    status: upload.status,
    hit: false,
    key,
    matchedKey,
    restoreKeys: [],
    archiveBytes: saved ? (upload.archiveBytes ?? null) : null,
    inflatedBytes: saved ? (upload.inflatedBytes ?? null) : null,
    fileCount: saved ? (upload.fileCount ?? null) : null,
    durationMs: typeof upload.finishedAtMs === "number" && typeof upload.startedAtMs === "number"
      ? Math.max(0, upload.finishedAtMs - upload.startedAtMs)
      : 0,
    timestamp: new Date().toISOString(),
  });
  log(
    `solo-toolchain-cache: background upload status=${upload.status} key=${key} (sealed at install time, #525)` +
      `${upload.error ? ` error=${upload.error}` : ""}`,
  );
  if (upload.status === "failed" || upload.status === "timeout" || upload.status === "worker-died") {
    if (logPath) {
      try {
        const text = (opts.readLog ?? ((p: string) => fs.readFileSync(p, "utf8")))(logPath);
        const tail = text.split(/\r?\n/).filter((line) => line.length > 0).slice(-40).join("\n");
        if (tail) log(`solo-toolchain-cache: upload worker log tail (${logPath}):\n${tail}`);
      } catch {
        // No worker diagnostic available.
      }
    }
  }
  const deletion = upload.repairDeletion;
  const repairDeletionComplete = deletion
    ? deletion.failed === 0 && deletion.deleted === deletion.found
    : false;
  if (restoreInvalid) {
    if (deletion && !repairDeletionComplete) {
      warn(
        `solo-toolchain-cache: could not fully delete poisoned key=${invalidMatchedKey}; ` +
          `found=${deletion.found} deleted=${deletion.deleted} failed=${deletion.failed}. ` +
          `The workflow token needs actions: write permission for automatic repair (#473).`,
      );
    }
    const repairRaceWonElsewhere = upload.status === "race-precheck-skipped" && repairDeletionComplete;
    if (!saved && !repairRaceWonElsewhere) {
      setFailed(
        `solo-toolchain-cache: failed to publish repaired replacement for poisoned key=${invalidMatchedKey}: ` +
          `${upload.status}${upload.error ? ` (${upload.error})` : ""}`,
      );
    }
  }
  return { status: upload.status };
}
