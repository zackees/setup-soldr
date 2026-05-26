// bench-cache-cell.mjs — single-cell driver for the cache-mode benchmark.
//
// One invocation = one matrix cell (one (os, layer, rep) combination). Emits
// one or two CSV rows to --out: a 'cold' row always, plus a 'warm' row for
// layers whose snapshot/restore actually affects subsequent build wall clock.
//
// Per-cell flow:
//   1. Prepare a clean workload checkout under ${RUNNER_TEMP}/workload
//   2. Cold build (cargo build --release in the workload dir) — record wall clock
//   3. Snapshot layer paths -> ${RUNNER_TEMP}/sim-cache/<layer>__<i>.tar.zst (tar+zstd -19 --long=27)
//   4. (build-affecting layers only) Wipe layer paths, then restore from snapshot
//   5. (build-affecting layers only) Warm build — record wall clock
//
// For layers that don't affect the workload's build (solo-toolchain, soldr-mini,
// setup-cache, baseline), the warm row is omitted; the CSV downstream treats
// those rows as "mechanics only" and skips speedup math.
//
// Usage:
//   node scripts/bench-cache-cell.mjs --layer=<name> --workload=<dirname> --rep=<n> --out=bench.csv
//
// Required env: RUNNER_TEMP (any path; tmpdir() is the local-dev fallback).
// Optional env: RUNNER_OS, BENCH_SKIP_BUILD (=1 to skip cargo for dry-runs).

import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathsForLayer, isActiveLayer, LAYER_NAMES } from "./bench-paths.mjs";

// Layers whose snapshot+restore changes what cargo finds at build time, so a
// warm rebuild is a meaningful measurement. Anything else is "mechanics only".
const BUILD_AFFECTING = new Set(["cargo-registry", "cook", "build", "target", "all-on"]);

// Layers we MUST NOT wipe — they're shared runner-image state. We still
// snapshot + restore-to-side, but skip the destructive wipe.
const WIPE_UNSAFE = new Set(["solo-toolchain", "soldr-mini", "setup-cache"]);

const args = parseArgs(process.argv.slice(2));
if (!args.layer) die("missing --layer");
if (!args.workload) die("missing --workload");
if (!LAYER_NAMES.includes(args.layer)) die(`unknown --layer=${args.layer} (allowed: ${LAYER_NAMES.join(",")})`);
const out = args.out ?? "bench.csv";
const rep = Number(args.rep ?? 1);
const skipBuild = process.env.BENCH_SKIP_BUILD === "1";
const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
const runnerOs = process.env.RUNNER_OS ?? process.platform;

const workloadSrc = path.resolve("scripts", "bench-workloads", args.workload);
const workloadDir = path.join(runnerTemp, "bench-workload");
const simCacheDir = path.join(runnerTemp, "sim-cache");
await fsp.mkdir(simCacheDir, { recursive: true });

await prepareWorkload(workloadSrc, workloadDir);

const env = { ...process.env, CARGO_TARGET_DIR: path.join(workloadDir, "target") };
const layerPaths = pathsForLayer(args.layer, { env, workloadDir });

log(`[bench] layer=${args.layer} workload=${args.workload} rep=${rep} paths=${layerPaths.length}`);

// --- 1. cold build -----------------------------------------------------------
const tColdStart = nowMs();
let wallColdS = 0;
if (skipBuild) {
  log(`[bench] BENCH_SKIP_BUILD=1, skipping cold cargo build`);
} else {
  await runCargoBuild(workloadDir, env);
}
wallColdS = (nowMs() - tColdStart) / 1000;
log(`[bench] cold build wall=${wallColdS.toFixed(2)}s`);

// --- 2. snapshot -------------------------------------------------------------
const snapshots = [];
let totalCompressedMb = 0;
let totalInflatedMb = 0;
let saveTimeS = 0;
for (let i = 0; i < layerPaths.length; i++) {
  const p = layerPaths[i];
  const archivePath = path.join(simCacheDir, `${args.layer}__${i}.tar.zst`);
  const inflated = await dirSizeBytes(path.join(p.parent, p.basename));
  if (inflated === 0) {
    log(`[bench] skip empty path ${p.parent}/${p.basename}`);
    continue;
  }
  const t0 = nowMs();
  await tarZstdCreate(archivePath, p.parent, p.basename);
  saveTimeS += (nowMs() - t0) / 1000;
  const compressed = await statSizeBytes(archivePath);
  snapshots.push({ ...p, archivePath, compressedBytes: compressed, inflatedBytes: inflated });
  totalCompressedMb += compressed / 1_000_000;
  totalInflatedMb += inflated / 1_000_000;
  log(`[bench] snap ${p.basename}: inflated=${(inflated / 1_000_000).toFixed(1)}MB compressed=${(compressed / 1_000_000).toFixed(1)}MB`);
}

const compressedMb = round(totalCompressedMb, 2);
const inflatedMb = round(totalInflatedMb, 2);
const ratio = totalInflatedMb > 0 ? round(totalInflatedMb / Math.max(totalCompressedMb, 0.001), 2) : 0;

const csv = [csvHeader()];
csv.push(csvRow({
  os: runnerOs, layer: args.layer, phase: "cold", wallClockS: round(wallColdS, 2),
  saveTimeS: round(saveTimeS, 2), restoreTimeS: "",
  compressedMb, inflatedMb, ratio,
  workload: args.workload, rep,
}));

// --- 3 + 4 + 5: restore + warm (only for build-affecting + wipe-safe) --------
const shouldWipe = !WIPE_UNSAFE.has(args.layer) && isActiveLayer(args.layer);
const shouldWarmBuild = BUILD_AFFECTING.has(args.layer) && isActiveLayer(args.layer);
let restoreTimeS = 0;

if (snapshots.length > 0) {
  if (shouldWipe) {
    for (const s of snapshots) {
      await rmrf(path.join(s.parent, s.basename));
    }
    log(`[bench] wiped ${snapshots.length} path(s)`);
  } else if (isActiveLayer(args.layer)) {
    log(`[bench] layer ${args.layer} is wipe-unsafe; restoring into side dirs for mechanics measurement only`);
  }

  for (const s of snapshots) {
    const restoreRoot = shouldWipe ? s.parent : path.join(runnerTemp, "sim-restore", args.layer);
    if (!shouldWipe) await fsp.mkdir(restoreRoot, { recursive: true });
    const t0 = nowMs();
    await tarZstdExtract(s.archivePath, restoreRoot);
    restoreTimeS += (nowMs() - t0) / 1000;
  }
  log(`[bench] restore time=${restoreTimeS.toFixed(2)}s`);
}

if (shouldWarmBuild) {
  const tWarmStart = nowMs();
  if (!skipBuild) await runCargoBuild(workloadDir, env);
  const wallWarmS = (nowMs() - tWarmStart) / 1000;
  log(`[bench] warm build wall=${wallWarmS.toFixed(2)}s`);

  csv.push(csvRow({
    os: runnerOs, layer: args.layer, phase: "warm", wallClockS: round(wallWarmS, 2),
    saveTimeS: "", restoreTimeS: round(restoreTimeS, 2),
    compressedMb, inflatedMb, ratio,
    workload: args.workload, rep,
  }));
} else if (snapshots.length > 0) {
  // emit a mechanics-only row so downstream collation has size/save/restore numbers
  csv.push(csvRow({
    os: runnerOs, layer: args.layer, phase: "mech", wallClockS: "",
    saveTimeS: round(saveTimeS, 2), restoreTimeS: round(restoreTimeS, 2),
    compressedMb, inflatedMb, ratio,
    workload: args.workload, rep,
  }));
}

await fsp.writeFile(out, csv.join("\n") + "\n", "utf8");
log(`[bench] wrote ${out} (${csv.length - 1} row(s))`);

// ============================== helpers ======================================

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg) { console.error(`bench-cache-cell: ${msg}`); process.exit(2); }
function log(msg) { console.log(msg); }
function nowMs() { return Number(process.hrtime.bigint() / 1_000_000n); }
function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }

function csvHeader() {
  return "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep";
}
function csvRow(r) {
  return [r.os, r.layer, r.phase, r.wallClockS, r.saveTimeS, r.restoreTimeS,
          r.compressedMb, r.inflatedMb, r.ratio, r.workload, r.rep].join(",");
}

async function prepareWorkload(src, dest) {
  await rmrf(dest);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await copyDir(src, dest);
  // Always start with no target/ so cold==cold.
  await rmrf(path.join(dest, "target"));
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "target") continue; // never copy build artifacts
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
}

async function statSizeBytes(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
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

async function tarZstdCreate(archivePath, parent, basename) {
  // tar -cf - -C <parent> <basename> | zstd -T0 -19 --long=27 -o <archive>
  // We shell out via a single bash pipeline because node's spawn pipe glue is
  // verbose and the bench runs on hosted runners where bash + zstd are both
  // available (Windows runners have bsdtar + zstd via choco/preinstall).
  if (process.platform === "win32") {
    // bsdtar on Windows accepts --use-compress-program; zstd is shipped via
    // setup-soldr-contract.yml's setup-node + preinstalled tools. Fall back
    // to direct tar with --zstd if zstd CLI isn't on PATH.
    await run("tar", ["--use-compress-program=zstd -T0 -19 --long=27", "-cf", archivePath, "-C", parent, basename]);
  } else {
    await run("bash", ["-c", `tar -cf - -C ${shellEscape(parent)} ${shellEscape(basename)} | zstd -T0 -19 --long=27 -o ${shellEscape(archivePath)}`]);
  }
}

async function tarZstdExtract(archivePath, extractRoot) {
  await fsp.mkdir(extractRoot, { recursive: true });
  if (process.platform === "win32") {
    await run("tar", ["--use-compress-program=zstd -d --long=27", "-xf", archivePath, "-C", extractRoot]);
  } else {
    await run("bash", ["-c", `zstd -d --long=27 -c ${shellEscape(archivePath)} | tar -xf - -C ${shellEscape(extractRoot)}`]);
  }
}

function shellEscape(s) {
  // Safe-enough for bash -c with our known-clean paths (no spaces/$/backticks
  // expected in $RUNNER_TEMP or our workload paths). Reject obviously-unsafe
  // input rather than emit a buggy escape.
  if (/['"`$\\\n]/.test(s)) throw new Error(`refusing to shell-escape unsafe path: ${s}`);
  return /[ ()]/.test(s) ? `"${s}"` : s;
}

async function runCargoBuild(dir, envExt) {
  await run("cargo", ["build", "--release", "--quiet"], { cwd: dir, env: envExt });
}
