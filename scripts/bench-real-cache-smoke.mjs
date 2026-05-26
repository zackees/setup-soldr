// bench-real-cache-smoke.mjs - tiny Actions-cache validation path for the
// cache-mode benchmark. It runs as two jobs: save a real cache entry after a
// cold build, then restore that entry in a downstream job and emit normal
// bench CSV rows.

import * as cache from "@actions/cache";
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = parseArgs(process.argv.slice(2));
const mode = args.mode;
if (mode !== "save" && mode !== "restore") die("missing or invalid --mode=save|restore");

const layer = args.layer ?? "target";
if (layer !== "target") die("real-cache smoke currently supports --layer=target only");

const workload = args.workload ?? "demo-small";
const rep = Number(args.rep ?? 1);
const out = args.out ?? (mode === "save" ? "bench-real-cache-state.json" : "bench-real-cache.csv");
const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
const runnerOs = process.env.RUNNER_OS ?? process.platform;
const workloadSrc = path.resolve("scripts", "bench-workloads", workload);
const workloadDir = path.join(runnerTemp, "bench-real-cache-workload");
const targetDir = path.join(workloadDir, "target");
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };

if (mode === "save") {
  await prepareWorkload(workloadSrc, workloadDir);
  const tCold = nowMs();
  await run("cargo", ["build", "--release", "--quiet"], { cwd: workloadDir, env });
  const coldWallS = secondsSince(tCold);
  const inflatedMb = round((await dirSizeBytes(targetDir)) / 1_000_000, 2);
  const key = [
    "setup-soldr-bench-real",
    sanitize(runnerOs),
    layer,
    sanitize(workload),
    `r${rep}`,
    process.env.GITHUB_RUN_ID ?? "local",
    process.env.GITHUB_RUN_ATTEMPT ?? "1",
  ].join("-");

  const tSave = nowMs();
  const cacheId = await cache.saveCache([targetDir], key);
  const saveTimeS = secondsSince(tSave);
  await writeJson(out, {
    version: 1,
    key,
    cacheId,
    os: runnerOs,
    layer,
    workload,
    rep,
    coldWallS: round(coldWallS, 2),
    saveTimeS: round(saveTimeS, 2),
    inflatedMb,
  });
  console.log(`[bench-real-cache] saved key=${key} id=${cacheId} cold=${coldWallS.toFixed(2)}s save=${saveTimeS.toFixed(2)}s`);
} else {
  const statePath = args.state;
  if (!statePath) die("restore mode requires --state=<json>");
  const state = JSON.parse(await fsp.readFile(statePath, "utf8"));
  if (state?.version !== 1 || !state.key) die(`invalid state file: ${statePath}`);

  await prepareWorkload(workloadSrc, workloadDir);
  const tRestore = nowMs();
  const matchedKey = await cache.restoreCache([targetDir], state.key);
  const restoreTimeS = secondsSince(tRestore);
  if (!matchedKey) die(`real cache restore missed key ${state.key}`);

  const tWarm = nowMs();
  await run("cargo", ["build", "--release", "--quiet"], { cwd: workloadDir, env });
  const warmWallS = secondsSince(tWarm);
  await writeCsv(out, state, {
    warmWallS: round(warmWallS, 2),
    restoreTimeS: round(restoreTimeS, 2),
  });
  console.log(`[bench-real-cache] restored key=${matchedKey} warm=${warmWallS.toFixed(2)}s restore=${restoreTimeS.toFixed(2)}s`);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg) {
  console.error(`bench-real-cache-smoke: ${msg}`);
  process.exit(2);
}

function nowMs() { return Number(process.hrtime.bigint() / 1_000_000n); }
function secondsSince(t0) { return (nowMs() - t0) / 1000; }
function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }
function sanitize(s) { return String(s).replace(/[^A-Za-z0-9_.-]+/g, "-"); }

async function writeJson(file, payload) {
  await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function writeCsv(file, state, warm) {
  const header = "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model";
  const common = {
    os: state.os ?? runnerOs,
    layer: state.layer ?? layer,
    workload: state.workload ?? workload,
    rep: state.rep ?? rep,
    inflatedMb: state.inflatedMb ?? "",
  };
  const rows = [
    [common.os, common.layer, "cold", state.coldWallS, state.saveTimeS, "", "", common.inflatedMb, "", common.workload, common.rep, "actions-cache", "actions/cache-service"].join(","),
    [common.os, common.layer, "warm", warm.warmWallS, "", warm.restoreTimeS, "", common.inflatedMb, "", common.workload, common.rep, "actions-cache", "actions/cache-service"].join(","),
  ];
  await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fsp.writeFile(file, [header, ...rows].join("\n") + "\n", "utf8");
}

async function prepareWorkload(src, dest) {
  await rmrf(dest);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await copyDir(src, dest);
  await rmrf(path.join(dest, "target"));
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "target") continue;
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
}

async function dirSizeBytes(dir) {
  let total = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try { total += (await fsp.stat(full)).size; } catch { /* ignore */ }
      } else if (e.isSymbolicLink()) {
        try { total += Math.max(1, Buffer.byteLength(await fsp.readlink(full))); } catch { /* ignore */ }
      }
    }
  }
  if (fs.existsSync(dir)) await walk(dir);
  return total;
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
