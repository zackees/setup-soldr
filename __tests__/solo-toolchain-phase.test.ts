// Tests for src/lib/solo-toolchain-phase.ts and src/lib/solo-toolchain-upload.ts
// (#525 T1/T2/T4-T8, #507).
//
// A shared fixture RUSTUP_HOME holds three unrelated toolchains with more
// than 10,000 files between them. Every filesystem call the phase makes goes
// through a recording SoloFs, so the tests can prove the phase never walks
// anything under toolchains/ except the one directory it resolves, and does
// no filesystem work at all when the layer is disabled.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { spawn } from "node:child_process";
import {
  defaultSoloFs,
  rustHostTriple,
  saveSoloCache,
  sealToolchainForSave,
  toolchainDirName,
  type SoloFs,
  type SoloRestoreResult,
} from "../src/lib/solo-toolchain-cache.js";
import {
  SOLO_STATE,
  SOLO_SUMMARY_FILENAME,
  runSoloToolchainPhase,
  soloToolchainCacheEnabled,
} from "../src/lib/solo-toolchain-phase.js";
import {
  SOLO_TOOLCHAIN_UPLOAD_WORKER_ARG,
  awaitSoloToolchainUpload,
  finalizeSoloToolchainSave,
  isZombieProcess,
  readSoloUploadResult,
  runSoloToolchainUploadWorker,
  startSoloToolchainUpload,
  writeSoloUploadResult,
  type SoloUploadConfig,
  type SoloUploadResult,
} from "../src/lib/solo-toolchain-upload.js";
import type { CacheOpStats } from "../src/lib/types.js";

type PhaseOptions = Parameters<typeof runSoloToolchainPhase>[0];
type PhaseDeps = PhaseOptions["deps"];
type WorkerDeps = NonNullable<Parameters<typeof runSoloToolchainUploadWorker>[2]>;

const HOST = "x86_64-unknown-linux-gnu";
const AARCH64 = "aarch64-unknown-linux-gnu";
const DIR = `1.98.1-${HOST}`;
const UNRELATED = [`stable-${HOST}`, `nightly-${HOST}`, `1.90.0-${HOST}`];
const FILES_PER_UNRELATED = 3_400;

let root = "";
let rustupHome = "";
let cargoHome = "";

function writeFile(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-solo-phase-"));
  rustupHome = path.join(root, "rustup-home");
  cargoHome = path.join(root, "cargo-home");
  for (const name of UNRELATED) {
    const tc = path.join(rustupHome, "toolchains", name);
    writeFile(path.join(tc, "lib", "rustlib", "components"), `rustc-${HOST}\nrust-docs-${HOST}\nrust-std-${HOST}\n`);
    for (let i = 0; i < FILES_PER_UNRELATED; i += 1) {
      writeFile(
        path.join(tc, "share", "doc", "rust", "html", `d${Math.floor(i / 200)}`, `page-${i}.html`),
        `<html>${i}</html>`,
      );
    }
  }
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

interface Harness {
  runnerTemp: string;
  calls: string[];
  fs: SoloFs;
  subPhases: string[];
  state: Map<string, string>;
  logs: string[];
  warns: string[];
  installs: boolean[];
  uploads: SoloUploadConfig[];
  exported: string[];
  restoreOps: CacheOpStats[];
  restoreCalls: number;
  sealCalls: number;
}

/** A SoloFs over the real one that records every string (path) argument. */
function recordingFs(calls: string[]): SoloFs {
  return new Proxy(defaultSoloFs, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        for (const arg of args) if (typeof arg === "string") calls.push(arg);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Reset the requested toolchain + proxies; keep the (expensive) unrelated fixture. */
function freshHarness(): Harness {
  fs.rmSync(path.join(rustupHome, "toolchains", DIR), { recursive: true, force: true });
  fs.rmSync(path.join(rustupHome, "update-hashes"), { recursive: true, force: true });
  fs.rmSync(path.join(cargoHome, "bin"), { recursive: true, force: true });
  writeFile(path.join(cargoHome, "bin", "rustc"), "runner-image rustc proxy");
  writeFile(path.join(cargoHome, "bin", "cargo"), "runner-image cargo proxy");
  const calls: string[] = [];
  return {
    runnerTemp: fs.mkdtempSync(path.join(root, "runner-temp-")),
    calls,
    fs: recordingFs(calls),
    subPhases: [],
    state: new Map(),
    logs: [],
    warns: [],
    installs: [],
    uploads: [],
    exported: [],
    restoreOps: [],
    restoreCalls: 0,
    sealCalls: 0,
  };
}

/** Materialize `toolchains/<DIR>` the way rustup lays it out. */
function writeRequestedToolchain(opts: { listedStd: string[]; stdWithLibcore: string[] }): void {
  const tc = path.join(rustupHome, "toolchains", DIR);
  const components = [`rustc-${HOST}`, ...opts.listedStd.map((t) => `rust-std-${t}`)].join("\n") + "\n";
  writeFile(path.join(tc, "lib", "rustlib", "components"), components);
  for (const target of opts.stdWithLibcore) {
    writeFile(path.join(tc, "lib", "rustlib", target, "lib", "libcore-a.rlib"), `libcore for ${target}`);
  }
  writeFile(path.join(tc, "bin", "rustc"), "rustc 1.98.1");
}

function fakeInstall(h: Harness): (forceRepair: boolean) => Promise<void> {
  return async (forceRepair) => {
    h.installs.push(forceRepair);
    writeRequestedToolchain({ listedStd: [HOST], stdWithLibcore: [HOST] });
    writeFile(path.join(rustupHome, "update-hashes", DIR), "update-hash");
    writeFile(path.join(cargoHome, "bin", "rustup"), "rustup proxy");
  };
}

function missRestore(h: Harness): NonNullable<PhaseDeps["restore"]> {
  return async (): Promise<SoloRestoreResult> => {
    h.restoreCalls += 1;
    return { hit: false, matchedKey: "", restoredBytes: 0, archivePath: null, verified: false };
  };
}

function hitRestore(h: Harness, materialize: () => void): NonNullable<PhaseDeps["restore"]> {
  return async (o): Promise<SoloRestoreResult> => {
    h.restoreCalls += 1;
    materialize();
    return {
      hit: true,
      matchedKey: o.keys.exact,
      restoredBytes: 1234,
      archivePath: o.cacheArchivePath ?? null,
      verified: true,
    };
  };
}

function phaseOptions(h: Harness, deps: Partial<PhaseDeps> = {}, enabled = true): PhaseOptions {
  return {
    enabled,
    rustupHome,
    cargoHome,
    runnerTemp: h.runnerTemp,
    channel: "1.98.1",
    release: "1.98.1",
    components: [],
    targets: [],
    runnerOs: "linux",
    runnerArch: "x64",
    platform: "linux",
    libc: "glibc",
    level: "3",
    debug: false,
    entrypoint: "unused-entrypoint.js",
    deps: {
      install: fakeInstall(h),
      verifyRustup: async () => true,
      restore: missRestore(h),
      seal: async (o) => {
        h.sealCalls += 1;
        return sealToolchainForSave(o);
      },
      startUpload: async (config) => {
        h.uploads.push(config);
        const workDir = path.join(h.runnerTemp, "setup-soldr-solo-upload");
        return {
          configPath: path.join(workDir, "config.json"),
          resultPath: path.join(workDir, "result.json"),
          logPath: path.join(workDir, "worker.log"),
          pid: 4242,
          spawnedAtMs: 1,
        };
      },
      fs: h.fs,
      timeSubPhase: async <T>(name: string, body: () => Promise<T>): Promise<T> => {
        h.subPhases.push(name);
        return body();
      },
      saveState: (k, v) => {
        h.state.set(k, v);
      },
      log: (m) => {
        h.logs.push(m);
      },
      warn: (m) => {
        h.warns.push(m);
      },
      exportToolchain: (ch) => {
        h.exported.push(ch);
      },
      recordRestore: (op) => {
        h.restoreOps.push(op);
      },
      ...deps,
    },
  };
}

/** Path segments relative to `<rustupHome>/toolchains`, or null when outside it. */
function toolchainsSegments(p: string): string[] | null {
  const rel = path.relative(path.join(rustupHome, "toolchains"), p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel === "" ? [] : rel.split(path.sep);
}

function callsUnderUnrelated(h: Harness): number {
  return h.calls.filter((p) => {
    const segs = toolchainsSegments(p);
    return segs !== null && segs.length > 0 && UNRELATED.includes(segs[0] as string);
  }).length;
}

/** Calls under toolchains/ that are NOT inside the requested toolchain dir. */
function callsUnderToolchains(h: Harness): number {
  return h.calls.filter((p) => {
    const segs = toolchainsSegments(p);
    return segs !== null && segs[0] !== DIR;
  }).length;
}

/** Every call under toolchains/, the requested dir included. */
function callsAnywhereUnderToolchains(h: Harness): number {
  return h.calls.filter((p) => toolchainsSegments(p) !== null).length;
}

function readSummary(h: Harness): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(h.runnerTemp, SOLO_SUMMARY_FILENAME), "utf8")) as Record<string, unknown>;
}

test("fixture resolves the requested toolchain dir for linux/x64/glibc", () => {
  const host = rustHostTriple("linux", "x64", "glibc");
  assert.equal(host, HOST);
  assert.equal(toolchainDirName("1.98.1", host ?? ""), DIR);
});

test("T1: an exact hit touches nothing under toolchains/ except the requested directory", async () => {
  const h = freshHarness();
  const result = await runSoloToolchainPhase(phaseOptions(h, {
    restore: hitRestore(h, () => writeRequestedToolchain({ listedStd: [HOST], stdWithLibcore: [HOST] })),
  }));
  assert.equal(result.outcome, "exact-hit");
  assert.equal(result.toolchainDir, DIR);
  assert.equal(callsUnderUnrelated(h), 0);
  assert.equal(callsUnderToolchains(h), 0);
  // A fixed handful of calls, independent of the >10k fixture files.
  assert.ok(h.calls.length <= 10, `expected a handful of fs calls, got ${h.calls.length}`);
  assert.deepEqual(h.installs, []);
  assert.deepEqual(h.exported, ["1.98.1"]);
  assert.equal(h.restoreOps.length, 1);
  assert.equal(h.restoreOps[0]?.hit, true);
});

test("T1: a miss does at most a fixed handful of calls outside the requested directory", async () => {
  const h = freshHarness();
  const result = await runSoloToolchainPhase(phaseOptions(h));
  assert.equal(result.outcome, "sealed");
  assert.equal(callsUnderUnrelated(h), 0);
  assert.ok(callsUnderToolchains(h) <= 3, `expected <= 3 calls outside ${DIR}, got ${callsUnderToolchains(h)}`);
  assert.deepEqual(h.installs, [false]);
  assert.equal(h.sealCalls, 1);
  // The seal holds exactly the requested toolchain (E4).
  const stagedToolchains = path.join(h.runnerTemp, "setup-soldr-solo-cache", "staged", "rustup-toolchains");
  assert.deepEqual(fs.readdirSync(stagedToolchains), [DIR]);
  assert.equal(h.uploads.length, 1);
  const upload = h.uploads[0] as SoloUploadConfig;
  assert.equal(upload.key, result.key);
  assert.equal(upload.stagingDir, path.join(h.runnerTemp, "setup-soldr-solo-cache", "staged"));
  assert.equal(upload.repairPoisonedKey, undefined);
  assert.equal(h.state.get(SOLO_STATE.enabled), "true");
  assert.equal(h.state.get(SOLO_STATE.outcome), "sealed");
  assert.ok(h.state.get(SOLO_STATE.uploadResultPath));
  assert.deepEqual(h.subPhases, ["solo-probe", "solo-restore", "rustup-install", "solo-seal"]);
  assert.ok(h.logs.some((m) => m.includes("background upload started pid=4242 (#525)")));
  const summary = readSummary(h);
  assert.equal(summary["outcome"], "sealed");
  assert.equal(summary["existedBefore"], false);
  assert.deepEqual(summary["proxyNames"], ["rustup"]);
  assert.ok((summary["sealed"] as { files: number }).files >= 3);
});

test("T2 (#507): the uploaded archive holds install-time bytes, not later job-step writes", async () => {
  const h = freshHarness();
  const result = await runSoloToolchainPhase(phaseOptions(h));
  assert.equal(result.outcome, "sealed");
  const config = h.uploads[0];
  assert.ok(config, "phase must hand a sealed directory to the uploader");

  const liveComponents = path.join(rustupHome, "toolchains", DIR, "lib", "rustlib", "components");
  const installTimeBytes = fs.readFileSync(liveComponents);
  // A later job step runs `rustup target add aarch64-unknown-linux-gnu`
  // (in-place write to components + a new std dir).
  fs.appendFileSync(liveComponents, `rust-std-${AARCH64}\n`);
  writeFile(
    path.join(rustupHome, "toolchains", DIR, "lib", "rustlib", AARCH64, "lib", "libcore-x.rlib"),
    "aarch64 libcore",
  );

  const workDir = path.join(h.runnerTemp, "upload");
  fs.mkdirSync(workDir, { recursive: true });
  const configPath = path.join(workDir, "config.json");
  const resultPath = path.join(workDir, "result.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  writeSoloUploadResult(resultPath, { status: "pending", spawnedAtMs: 1, pid: 4242 });

  const captured = new Map<string, Buffer>();
  const capture = (base: string, dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) capture(base, abs);
      else if (entry.isFile()) captured.set(path.relative(base, abs).split(path.sep).join("/"), fs.readFileSync(abs));
    }
  };
  const compress: WorkerDeps["compress"] = async (o) => {
    capture(o.cacheDir, o.cacheDir);
    const archivePath = `${o.cacheDir}.tar.zst`;
    fs.writeFileSync(archivePath, "fake archive");
    let inflated = 0;
    for (const bytes of captured.values()) inflated += bytes.length;
    return { archivePath, archiveBytes: 12, inflatedBytes: inflated, fileCount: captured.size, payload: null };
  };
  const upload = await runSoloToolchainUploadWorker(configPath, resultPath, {
    // Skip the lookupOnly network probe; everything else is the real save.
    saveSoloCache: (o) => saveSoloCache({ ...o, skipExistingProbe: true }),
    compress,
    saveCache: async () => 1,
    env: {},
    log: () => undefined,
  });
  assert.equal(upload.status, "saved", upload.error);
  assert.equal(upload.cacheId, 1);

  const componentsEntries = [...captured.keys()].filter((p) => p.endsWith("lib/rustlib/components"));
  assert.equal(componentsEntries.length, 1);
  const archived = captured.get(componentsEntries[0] as string) as Buffer;
  assert.ok(archived.equals(installTimeBytes), `archived components changed after install:\n${archived.toString("utf8")}`);
  assert.deepEqual([...captured.keys()].filter((p) => p.includes("aarch64")), []);

  const recorded = readSoloUploadResult(resultPath);
  assert.equal(recorded?.status, "saved");
  assert.equal(recorded?.pid, 4242);
  assert.equal(recorded?.spawnedAtMs, 1);
});

test("T4: an exact hit does no install, seal or upload, and the post step logs no staging", async () => {
  const h = freshHarness();
  const result = await runSoloToolchainPhase(phaseOptions(h, {
    restore: hitRestore(h, () => writeRequestedToolchain({ listedStd: [HOST], stdWithLibcore: [HOST] })),
  }));
  assert.equal(result.outcome, "exact-hit");
  assert.deepEqual(h.installs, []);
  assert.equal(h.sealCalls, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.subPhases.includes("solo-seal"), false);
  assert.equal(h.subPhases.includes("rustup-install"), false);

  const postLogs: string[] = [];
  const failures: string[] = [];
  const records: CacheOpStats[] = [];
  let awaitCalls = 0;
  const finalized = await finalizeSoloToolchainSave({
    getState: (k) => h.state.get(k) ?? "",
    log: (m) => postLogs.push(m),
    warn: (m) => postLogs.push(m),
    setFailed: (m) => failures.push(m),
    record: (op) => records.push(op),
    awaitUpload: async () => {
      awaitCalls += 1;
      return { status: "saved", spawnedAtMs: 0 };
    },
  });
  assert.equal(finalized.status, "skipped-exact-hit");
  assert.equal(awaitCalls, 0);
  assert.deepEqual(failures, []);
  assert.deepEqual(records, []);
  assert.deepEqual(postLogs.filter((m) => /stag/i.test(m)), []);
});

test("T5: when the image already ships the release, one stat and nothing written", async () => {
  const h = freshHarness();
  writeRequestedToolchain({ listedStd: [HOST], stdWithLibcore: [HOST] });
  const result = await runSoloToolchainPhase(phaseOptions(h));
  assert.equal(result.outcome, "image-provided");
  assert.equal(callsAnywhereUnderToolchains(h), 1);
  assert.equal(h.restoreCalls, 0);
  assert.equal(h.sealCalls, 0);
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(h.installs, [false]);
  assert.deepEqual(h.subPhases, ["solo-probe", "rustup-install"]);
  assert.equal(h.state.get(SOLO_STATE.enabled), "true");
  assert.equal(h.state.get(SOLO_STATE.outcome), "image-provided");
  assert.equal(h.state.get(SOLO_STATE.uploadResultPath), undefined);
  assert.ok(h.logs.some((m) => m.includes(`${DIR} already present`)));
});

test("T6: a restored toolchain that lists a target without its std is repaired (#473)", async () => {
  const h = freshHarness();
  const result = await runSoloToolchainPhase(phaseOptions(h, {
    // aarch64 is not declared, yet the poisoned entry claims its std.
    restore: hitRestore(h, () => writeRequestedToolchain({ listedStd: [HOST, AARCH64], stdWithLibcore: [HOST] })),
  }));
  assert.equal(result.restoreInvalid, true);
  assert.equal(result.matchedKey, result.key);
  assert.deepEqual(h.installs, [true]);
  assert.equal(result.outcome, "sealed");
  assert.equal(h.uploads[0]?.repairPoisonedKey, result.matchedKey);
  assert.equal(h.state.get(SOLO_STATE.restoreInvalid), "true");
  assert.equal(h.state.get(SOLO_STATE.invalidMatchedKey), result.matchedKey);
  assert.ok(h.warns.some((m) => m.includes("#473")));
  assert.equal(h.restoreOps[0]?.hit, false);
});

test("T7: cache: false disables the solo toolchain cache", async () => {
  assert.equal(soloToolchainCacheEnabled({ soloToolchainCache: "true", cache: "false" }), false);
  assert.equal(soloToolchainCacheEnabled({ soloToolchainCache: "true", cache: "true" }), true);
  assert.equal(soloToolchainCacheEnabled({ soloToolchainCache: "false", cache: "true" }), false);
  assert.equal(soloToolchainCacheEnabled({ soloToolchainCache: "true", cache: "" }), true);

  const h = freshHarness();
  const result = await runSoloToolchainPhase(phaseOptions(h, {}, false));
  assert.equal(result.outcome, "disabled");
  assert.equal(h.restoreCalls, 0);
  assert.equal(h.uploads.length, 0);
});

test("T8: with the cache off, no filesystem scans, no lookup and no save", async () => {
  const h = freshHarness();
  const result = await runSoloToolchainPhase(phaseOptions(h, {}, false));
  assert.equal(result.outcome, "disabled");
  assert.deepEqual(h.calls, []);
  assert.equal(h.subPhases.some((n) => n.startsWith("snapshot") || n.startsWith("solo-")), false);
  assert.deepEqual(h.subPhases, ["rustup-install"]);
  assert.deepEqual(h.installs, [false]);
  assert.equal(h.restoreCalls, 0);
  assert.equal(h.sealCalls, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.state.get(SOLO_STATE.enabled), "false");
  assert.deepEqual(readSummary(h), { schema: 1, enabled: false, outcome: "disabled" });

  const postLogs: string[] = [];
  let awaitCalls = 0;
  const finalized = await finalizeSoloToolchainSave({
    getState: (k) => h.state.get(k) ?? "",
    log: (m) => postLogs.push(m),
    warn: (m) => postLogs.push(m),
    setFailed: (m) => postLogs.push(m),
    record: () => undefined,
    awaitUpload: async () => {
      awaitCalls += 1;
      return { status: "saved", spawnedAtMs: 0 };
    },
  });
  assert.equal(finalized.status, "disabled");
  assert.equal(awaitCalls, 0);
  assert.deepEqual(postLogs, []);
});

function uploadTmp(): { dir: string; resultPath: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(root, "upload-"));
  return { dir, resultPath: path.join(dir, "result.json"), configPath: path.join(dir, "config.json") };
}

test("awaitSoloToolchainUpload uploads in-process once when the worker is gone", async () => {
  const { resultPath, configPath } = uploadTmp();
  writeSoloUploadResult(resultPath, { status: "uploading", spawnedAtMs: 10, pid: 999_999, startedAtMs: 11 });
  let runs = 0;
  const sleeps: number[] = [];
  const outcome = await awaitSoloToolchainUpload({
    resultPath,
    configPath,
    pollMs: 5,
    isAlive: () => false,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    runInProcess: async (): Promise<SoloUploadResult> => {
      runs += 1;
      return { status: "saved", spawnedAtMs: 10, cacheId: 7 };
    },
  });
  assert.equal(runs, 1);
  assert.equal(outcome.status, "saved");
  assert.equal(outcome.cacheId, 7);
  assert.deepEqual(sleeps, [5]);
});

test("isZombieProcess treats an unreaped worker as dead", () => {
  assert.equal(isZombieProcess(42, () => "42 (node) Z 1 42 42 0 -1"), true);
  assert.equal(isZombieProcess(42, () => "42 (node worker) S 1 42 42 0 -1"), false);
  // comm may itself contain ") "; the state follows the LAST ')'.
  assert.equal(isZombieProcess(42, () => "42 (a) R (b) Z 1 42"), true);
  assert.equal(isZombieProcess(42, () => {
    throw new Error("ENOENT");
  }), false);
});

test("awaitSoloToolchainUpload returns a terminal result immediately", async () => {
  const { resultPath, configPath } = uploadTmp();
  writeSoloUploadResult(resultPath, { status: "saved", spawnedAtMs: 1, cacheId: 3 });
  const outcome = await awaitSoloToolchainUpload({
    resultPath,
    configPath,
    isAlive: () => true,
    sleep: async () => {
      throw new Error("must not poll a terminal result");
    },
    runInProcess: async () => {
      throw new Error("must not re-run a finished upload");
    },
  });
  assert.equal(outcome.status, "saved");
  assert.equal(outcome.cacheId, 3);
});

test("awaitSoloToolchainUpload times out while a live worker is still uploading", async () => {
  const { resultPath, configPath } = uploadTmp();
  writeSoloUploadResult(resultPath, { status: "uploading", spawnedAtMs: 1, pid: 4242 });
  let clock = 0;
  const outcome = await awaitSoloToolchainUpload({
    resultPath,
    configPath,
    timeoutMs: 1_000,
    pollMs: 250,
    now: () => clock,
    isAlive: () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    runInProcess: async () => {
      throw new Error("a live worker must not be replaced");
    },
  });
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.pid, 4242);
  assert.equal(outcome.spawnedAtMs, 1);
});

test("startSoloToolchainUpload spawns a detached worker and never writes a token", async () => {
  const { dir } = uploadTmp();
  const spawned: Array<{ command: string; args: readonly string[]; options: { detached?: boolean } }> = [];
  let unrefs = 0;
  const fakeSpawn = ((command: string, args: readonly string[], options: { detached?: boolean }) => {
    spawned.push({ command, args, options });
    return {
      pid: 4242,
      unref: () => {
        unrefs += 1;
      },
      on: () => undefined,
    };
  }) as unknown as typeof spawn;
  const started = await startSoloToolchainUpload({
    config: {
      stagingDir: path.join(dir, "staged"),
      key: "solo-toolchain-v4-linux-x64-glibc-rustc1.98.1-cnone-tnone",
      level: "9",
      cacheArchivePath: path.join(dir, "setup-soldr-solo-cache.tar.zst"),
      debug: false,
    },
    workDir: path.join(dir, "work"),
    entrypoint: "/action/dist-main/index.js",
    spawnImpl: fakeSpawn,
    now: () => 77,
  });
  assert.equal(started.pid, 4242);
  assert.equal(started.spawnedAtMs, 77);
  assert.equal(unrefs, 1);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.command, process.execPath);
  assert.deepEqual(spawned[0]?.args, [
    "/action/dist-main/index.js",
    SOLO_TOOLCHAIN_UPLOAD_WORKER_ARG,
    started.configPath,
    started.resultPath,
  ]);
  assert.equal(spawned[0]?.options.detached, true);
  const recorded = readSoloUploadResult(started.resultPath);
  assert.equal(recorded?.status, "pending");
  assert.equal(recorded?.pid, 4242);
  assert.equal(recorded?.spawnedAtMs, 77);
  assert.equal(/token/i.test(fs.readFileSync(started.configPath, "utf8")), false);
});

function sealedState(extra: Record<string, string> = {}): Map<string, string> {
  return new Map<string, string>([
    [SOLO_STATE.enabled, "true"],
    [SOLO_STATE.outcome, "sealed"],
    [SOLO_STATE.exactKey, "solo-key"],
    [SOLO_STATE.matchedKey, ""],
    [SOLO_STATE.restoreInvalid, "false"],
    [SOLO_STATE.invalidMatchedKey, ""],
    [SOLO_STATE.uploadResultPath, "/tmp/solo/result.json"],
    [SOLO_STATE.uploadConfigPath, "/tmp/solo/config.json"],
    [SOLO_STATE.uploadLogPath, "/tmp/solo/worker.log"],
    ...Object.entries(extra),
  ]);
}

async function finalizeWith(
  state: Map<string, string>,
  upload: SoloUploadResult,
): Promise<{ status: string; logs: string[]; failures: string[]; records: CacheOpStats[] }> {
  const logs: string[] = [];
  const failures: string[] = [];
  const records: CacheOpStats[] = [];
  const { status } = await finalizeSoloToolchainSave({
    getState: (k) => state.get(k) ?? "",
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    setFailed: (m) => failures.push(m),
    record: (op) => records.push(op),
    awaitUpload: async () => upload,
    readLog: () => "worker line 1\nworker line 2\n",
  });
  return { status, logs, failures, records };
}

test("finalizeSoloToolchainSave records a saved background upload", async () => {
  const out = await finalizeWith(sealedState(), {
    status: "saved",
    spawnedAtMs: 1,
    startedAtMs: 10,
    finishedAtMs: 110,
    cacheId: 5,
    archiveBytes: 100,
    inflatedBytes: 200,
    fileCount: 3,
  });
  assert.equal(out.status, "saved");
  assert.deepEqual(out.failures, []);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0]?.operation, "save");
  assert.equal(out.records[0]?.status, "saved");
  assert.equal(out.records[0]?.archiveBytes, 100);
  assert.equal(out.records[0]?.durationMs, 100);
  assert.ok(out.logs.some((m) => m.includes("background upload status=saved key=solo-key (sealed at install time, #525)")));
  assert.deepEqual(out.logs.filter((m) => /stag/i.test(m)), []);
});

test("finalizeSoloToolchainSave fails a repair whose replacement did not publish", async () => {
  const out = await finalizeWith(
    sealedState({ [SOLO_STATE.restoreInvalid]: "true", [SOLO_STATE.invalidMatchedKey]: "poisoned-key" }),
    { status: "failed", spawnedAtMs: 1, error: "boom", repairDeletion: { found: 1, deleted: 1, failed: 0 } },
  );
  assert.equal(out.status, "failed");
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0] ?? "", /failed to publish repaired replacement for poisoned key=poisoned-key: failed/);
  assert.ok(out.logs.some((m) => m.includes("worker line 2")));
  assert.equal(out.records[0]?.archiveBytes, null);
});

test("finalizeSoloToolchainSave accepts a repair race won elsewhere after full deletion", async () => {
  const out = await finalizeWith(
    sealedState({ [SOLO_STATE.restoreInvalid]: "true", [SOLO_STATE.invalidMatchedKey]: "poisoned-key" }),
    { status: "race-precheck-skipped", spawnedAtMs: 1, repairDeletion: { found: 2, deleted: 2, failed: 0 } },
  );
  assert.deepEqual(out.failures, []);
});

test("finalizeSoloToolchainSave fails a repair that sealed nothing", async () => {
  const out = await finalizeWith(
    sealedState({
      [SOLO_STATE.outcome]: "seal-failed",
      [SOLO_STATE.restoreInvalid]: "true",
      [SOLO_STATE.invalidMatchedKey]: "poisoned-key",
    }),
    { status: "saved", spawnedAtMs: 1 },
  );
  assert.equal(out.status, "skipped-seal-failed");
  assert.equal(out.records.length, 0);
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0] ?? "", /sealed no replacement \(#473\)/);
});
