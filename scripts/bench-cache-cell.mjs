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
//   4. (build-affecting layers only) Wipe layer paths, target/, and any
//      out-of-scope zccache state, then restore from snapshot
//   5. (build-affecting layers only) Warm build — record wall clock
//
// The solo-toolchain cell supports a separate --pre-snapshot-out mode. The
// workflow runs that before setup-soldr, then passes --pre-snapshot-in to the
// measured cell so only toolchain files added on top of the runner image are
// archived.
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
const BUILD_AFFECTING = new Set(["cargo-registry", "cook", "cook-production", "build", "target", "all-on"]);

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
const cacheBackend = args["cache-backend"] ?? process.env.BENCH_CACHE_BACKEND ?? "local-tar-zstd";
const compressionModel = args["compression-model"] ?? process.env.BENCH_COMPRESSION_MODEL ?? "zstd-19-long27";

const workloadSrc = path.resolve("scripts", "bench-workloads", args.workload);
const workloadDir = path.join(runnerTemp, "bench-workload");
const simCacheDir = path.join(runnerTemp, "sim-cache");
await fsp.mkdir(simCacheDir, { recursive: true });

const env = { ...process.env, CARGO_TARGET_DIR: path.join(workloadDir, "target") };
const layerPaths = pathsForLayer(args.layer, { env, workloadDir });
const soloToolchainBasePaths = pathsForLayer("solo-toolchain", { env, workloadDir, includeRunnerToolchain: true });
const csvRows = [];
await writeCsv(csvRows);

log(`[bench] layer=${args.layer} workload=${args.workload} rep=${rep} paths=${layerPaths.length}`);

if (args["pre-snapshot-out"]) {
  if (args.layer !== "solo-toolchain" && args.layer !== "all-on") {
    die("--pre-snapshot-out is only supported for --layer=solo-toolchain or --layer=all-on");
  }
  await writePathStates(args["pre-snapshot-out"], soloToolchainBasePaths);
  log(`[bench] wrote pre-snapshot ${args["pre-snapshot-out"]}`);
  process.exit(0);
}

await prepareWorkload(workloadSrc, workloadDir);

// solo-toolchain overlaps runner-image state. Capture that baseline before the
// setup-soldr action runs, then only archive post-setup/cold added files.
const tracksSoloToolchainDelta = args.layer === "solo-toolchain" || args.layer === "all-on";
const preSnapshotStates = tracksSoloToolchainDelta
  ? args["pre-snapshot-in"]
    ? await readPathStates(args["pre-snapshot-in"])
    : await snapshotPathStates(soloToolchainBasePaths)
  : null;

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
let snapshotPaths = layerPaths;
let soloToolchainDeltaPaths = [];
if (preSnapshotStates) {
  soloToolchainDeltaPaths = await materializeDeltaPaths(
    soloToolchainBasePaths,
    preSnapshotStates,
    path.join(runnerTemp, "sim-delta", args.layer, "solo-toolchain"),
  );
  snapshotPaths = args.layer === "solo-toolchain"
    ? soloToolchainDeltaPaths
    : dedupeLayerPaths([...layerPaths, ...soloToolchainDeltaPaths]);
}
const soloToolchainDeltaEmpty = args.layer === "solo-toolchain" && preSnapshotStates && snapshotPaths.length === 0;
const allOnSoloToolchainDeltaEmpty = args.layer === "all-on" && preSnapshotStates && soloToolchainDeltaPaths.length === 0;
if (soloToolchainDeltaEmpty) {
  log(`[bench] solo-toolchain delta is empty; emitting mechanics row without save/restore`);
} else if (allOnSoloToolchainDeltaEmpty) {
  log(`[bench] all-on solo-toolchain delta is empty; runner-image toolchains excluded from snapshot`);
}

const snapshots = [];
let totalCompressedMb = 0;
let totalInflatedMb = 0;
let saveTimeS = 0;
for (let i = 0; i < snapshotPaths.length; i++) {
  const p = snapshotPaths[i];
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

csvRows.push(csvRow({
  os: runnerOs, layer: args.layer, phase: "cold", wallClockS: round(wallColdS, 2),
  saveTimeS: round(saveTimeS, 2), restoreTimeS: "",
  compressedMb, inflatedMb, ratio,
  workload: args.workload, rep,
}));
await writeCsv(csvRows);

// --- 3 + 4 + 5: restore + warm (only for build-affecting + wipe-safe) --------
const shouldWipe = !WIPE_UNSAFE.has(args.layer) && isActiveLayer(args.layer);
const shouldWarmBuild = BUILD_AFFECTING.has(args.layer) && isActiveLayer(args.layer);
const unsafeSnapshotKeys = unsafePathKeys(args.layer, env, workloadDir);
let restoreTimeS = 0;

if (snapshots.length > 0) {
  if (shouldWipe) {
    let wiped = 0;
    for (const s of snapshots) {
      if (unsafeSnapshotKeys.has(pathKey(s))) continue;
      await rmrf(path.join(s.parent, s.basename));
      wiped++;
    }
    log(`[bench] wiped ${wiped} path(s)`);
  } else if (isActiveLayer(args.layer)) {
    log(`[bench] layer ${args.layer} is wipe-unsafe; restoring into side dirs for mechanics measurement only`);
  }
}

if (shouldWarmBuild && shouldWipe) {
  await rmrf(env.CARGO_TARGET_DIR);
  log(`[bench] wiped CARGO_TARGET_DIR before warm build: ${env.CARGO_TARGET_DIR}`);
}

if (shouldWipeBuildCacheBeforeWarm(args.layer)) {
  let wipedBuildPaths = 0;
  for (const p of pathsForLayer("build", { env, workloadDir })) {
    await rmrf(path.join(p.parent, p.basename));
    wipedBuildPaths++;
  }
  log(`[bench] wiped build-cache path(s) before warm build: ${wipedBuildPaths}`);
}

if (snapshots.length > 0) {
  for (const s of snapshots) {
    const restoreLive = shouldWipe && !unsafeSnapshotKeys.has(pathKey(s));
    const restoreRoot = restoreLive ? s.parent : path.join(runnerTemp, "sim-restore", args.layer);
    if (!restoreLive) await fsp.mkdir(restoreRoot, { recursive: true });
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

  csvRows.push(csvRow({
    os: runnerOs, layer: args.layer, phase: "warm", wallClockS: round(wallWarmS, 2),
    saveTimeS: "", restoreTimeS: round(restoreTimeS, 2),
    compressedMb, inflatedMb, ratio,
    workload: args.workload, rep,
  }));
  await writeCsv(csvRows);
} else if (snapshots.length > 0 || soloToolchainDeltaEmpty) {
  // emit a mechanics-only row so downstream collation has size/save/restore numbers
  csvRows.push(csvRow({
    os: runnerOs, layer: args.layer, phase: "mech", wallClockS: "",
    saveTimeS: round(saveTimeS, 2), restoreTimeS: round(restoreTimeS, 2),
    compressedMb, inflatedMb, ratio,
    workload: args.workload, rep,
  }));
  await writeCsv(csvRows);
}

log(`[bench] wrote ${out} (${csvRows.length} row(s))`);

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
  return "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model";
}
function csvRow(r) {
  return [r.os, r.layer, r.phase, r.wallClockS, r.saveTimeS, r.restoreTimeS,
          r.compressedMb, r.inflatedMb, r.ratio, r.workload, r.rep,
          r.cacheBackend ?? cacheBackend, r.compressionModel ?? compressionModel].join(",");
}

async function writeCsv(rows) {
  await fsp.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fsp.writeFile(out, [csvHeader(), ...rows].join("\n") + "\n", "utf8");
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

async function snapshotPathStates(paths) {
  const states = new Map();
  for (const p of paths) {
    states.set(path.resolve(p.parent, p.basename), await fileStateMap(path.join(p.parent, p.basename)));
  }
  return states;
}

async function writePathStates(outPath, paths) {
  const states = await snapshotPathStates(paths);
  const payload = {
    version: 1,
    roots: [...states].map(([root, entries]) => ({
      root,
      entries: [...entries],
    })),
  };
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(payload), "utf8");
}

async function readPathStates(inPath) {
  if (!inPath) throw new Error("no pre-snapshot input");
  const payload = JSON.parse(await fsp.readFile(inPath, "utf8"));
  if (payload?.version !== 1 || !Array.isArray(payload.roots)) {
    throw new Error(`invalid pre-snapshot file: ${inPath}`);
  }
  const states = new Map();
  for (const root of payload.roots) {
    if (typeof root?.root !== "string" || !Array.isArray(root.entries)) continue;
    states.set(path.resolve(root.root), new Map(root.entries));
  }
  return states;
}

async function materializeDeltaPaths(paths, beforeStates, deltaRoot) {
  await rmrf(deltaRoot);
  const deltaPaths = [];
  for (const p of paths) {
    const srcRoot = path.join(p.parent, p.basename);
    const before = beforeStates.get(path.resolve(srcRoot)) ?? new Map();
    const after = await fileStateMap(srcRoot);
    let copied = 0;
    for (const [rel, state] of after) {
      if (before.has(rel)) continue;
      const dest = path.join(deltaRoot, p.basename, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await copyEntry(path.join(srcRoot, rel), dest, state);
      copied++;
    }
    if (copied > 0) {
      deltaPaths.push({ parent: deltaRoot, basename: p.basename });
      log(`[bench] solo-toolchain delta ${p.basename}: ${copied} added entr${copied === 1 ? "y" : "ies"}`);
    }
  }
  return deltaPaths;
}

async function fileStateMap(root) {
  const out = new Map();
  async function walk(d, relBase) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(full, rel);
      } else if (e.isSymbolicLink()) {
        try {
          const linkTarget = await fsp.readlink(full);
          out.set(rel, { kind: "symlink", linkTarget });
        } catch { /* ignore */ }
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          out.set(rel, { kind: "file", size: st.size });
        } catch { /* ignore */ }
      }
    }
  }
  if (fs.existsSync(root)) await walk(root, "");
  return out;
}

async function copyEntry(src, dest, state) {
  if (state?.kind === "symlink") {
    await fsp.symlink(state.linkTarget, dest).catch(async () => {
      const resolved = path.resolve(path.dirname(src), state.linkTarget);
      await fsp.copyFile(resolved, dest);
    });
    return;
  }
  await fsp.copyFile(src, dest);
}

function unsafePathKeys(layer, env, workloadDir) {
  const keys = new Set();
  if (WIPE_UNSAFE.has(layer)) {
    for (const p of pathsForLayer(layer, { env, workloadDir })) keys.add(pathKey(p));
    return keys;
  }
  if (layer !== "all-on") return keys;
  for (const name of WIPE_UNSAFE) {
    for (const p of pathsForLayer(name, { env, workloadDir })) keys.add(pathKey(p));
  }
  return keys;
}

function shouldWipeBuildCacheBeforeWarm(layer) {
  return BUILD_AFFECTING.has(layer) && !WIPE_UNSAFE.has(layer) && layer !== "build" && layer !== "all-on";
}

function pathKey(p) {
  return path.resolve(p.parent, p.basename);
}

function dedupeLayerPaths(paths) {
  const acc = [];
  for (const p of paths) addDedupedPath(acc, p);
  return acc;
}

function addDedupedPath(acc, candidate) {
  const candidateTarget = path.resolve(candidate.parent, candidate.basename);
  for (let i = 0; i < acc.length; i++) {
    const existingTarget = path.resolve(acc[i].parent, acc[i].basename);
    if (pathCovers(existingTarget, candidateTarget)) return;
    if (pathCovers(candidateTarget, existingTarget)) {
      acc.splice(i, 1);
      i--;
    }
  }
  acc.push(candidate);
}

function pathCovers(parentTarget, childTarget) {
  if (parentTarget === childTarget) return true;
  const rel = path.relative(parentTarget, childTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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
