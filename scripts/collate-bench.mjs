// collate-bench.mjs — concatenate per-cell CSVs into one matrix CSV and
// compute derived columns. Usage:
//   node scripts/collate-bench.mjs <input-dir> [> bench-matrix.csv]
//
// Walks <input-dir> recursively; every *.csv file is treated as a per-cell
// output from bench-cache-cell.mjs (same header row). Derived columns appended
// to the right of the input schema: speedup_s, net_benefit_s,
// mb_per_second_saved, break_even_warm_hits, cold_plus_save_s.
// Speedup math only applies to layers with both 'cold' and 'warm' rows.

import * as fs from "node:fs";
import * as path from "node:path";

const inputDir = process.argv[2];
if (!inputDir) { console.error("usage: collate-bench.mjs <input-dir>"); process.exit(2); }

const HEADER_LEGACY = "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep";
const HEADER = HEADER_LEGACY + ",cache_backend,compression_model";
const HEADER_OUT = HEADER + ",speedup_s,net_benefit_s,mb_per_second_saved,break_even_warm_hits,cold_plus_save_s";

const rows = [];
walk(inputDir, (file) => {
  if (!file.endsWith(".csv")) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return;
  const header = lines[0];
  if (header !== HEADER && header !== HEADER_LEGACY) {
    console.error(`collate-bench: skip ${file} (unexpected header)`);
    return;
  }
  for (const line of lines.slice(1)) {
    rows.push(parseRow(line, header));
  }
});

// index cold rows by (os, layer, workload, rep) so we can compute speedup_s
// against the matching warm row.
const coldByKey = new Map();
for (const r of rows) {
  if (r.phase === "cold") coldByKey.set(rowKey(r), r);
}

const out = [HEADER_OUT];
const sorted = rows.slice().sort((a, b) => {
  return a.os.localeCompare(b.os) || a.layer.localeCompare(b.layer)
      || a.rep - b.rep || a.phase.localeCompare(b.phase);
});

for (const r of sorted) {
  let speedup = "";
  let netBenefit = "";
  let mbPerSecond = "";
  let breakEvenWarmHits = "";
  let coldPlusSave = "";
  const cold = coldByKey.get(rowKey(r));
  if (cold && isNum(cold.wall_clock_s)) {
    const save = isNum(cold.save_time_s) ? Number(cold.save_time_s) : 0;
    coldPlusSave = String(round(Number(cold.wall_clock_s) + save, 2));
  }
  if (r.phase === "warm") {
    if (cold && isNum(cold.wall_clock_s) && isNum(r.wall_clock_s)) {
      const s = round(Number(cold.wall_clock_s) - Number(r.wall_clock_s), 2);
      speedup = String(s);
      if (isNum(r.restore_time_s)) {
        const net = round(s - Number(r.restore_time_s), 2);
        netBenefit = String(net);
        if (isNum(cold.save_time_s) && net > 0) {
          breakEvenWarmHits = String(round(Number(cold.save_time_s) / net, 2));
        }
      }
      if (isNum(r.compressed_mb) && s > 0.05) {
        mbPerSecond = String(round(Number(r.compressed_mb) / s, 2));
      }
    }
  }
  out.push([
    r.os, r.layer, r.phase, r.wall_clock_s, r.save_time_s, r.restore_time_s,
    r.compressed_mb, r.inflated_mb, r.ratio, r.workload, r.rep,
    r.cache_backend, r.compression_model,
    speedup, netBenefit, mbPerSecond, breakEvenWarmHits, coldPlusSave,
  ].join(","));
}

process.stdout.write(out.join("\n") + "\n");

// =============================== helpers =====================================

function walk(dir, visit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, visit);
    else if (e.isFile()) visit(full);
  }
}

function parseRow(line, header) {
  const c = line.split(",");
  return {
    os: c[0], layer: c[1], phase: c[2],
    wall_clock_s: c[3], save_time_s: c[4], restore_time_s: c[5],
    compressed_mb: c[6], inflated_mb: c[7], ratio: c[8],
    workload: c[9], rep: c[10],
    cache_backend: header === HEADER ? c[11] : "local-tar-zstd",
    compression_model: header === HEADER ? c[12] : "zstd-19-long27",
  };
}

function rowKey(r) { return `${r.os}|${r.layer}|${r.workload}|${r.rep}`; }
function isNum(s) { return s !== "" && s !== undefined && !Number.isNaN(Number(s)); }
function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }
