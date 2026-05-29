// expand-bench-matrix.mjs — parse workflow_dispatch inputs into a GitHub
// Actions matrix include[] list.
//
// Inputs (all comma-separated strings, read from env):
//   INPUT_LAYERS  default: all eight layer names
//   INPUT_OSES    default: ubuntu-24.04
//   INPUT_REPS    default: 1
//
// Reps presets (issue #191): a named preset gives a documented multi-rep run so
// the summary's min/p50/p95/max spread is meaningful. Selected via either:
//   --reps-preset=<name>  (argv)
//   BENCH_REPS_PRESET=<name>  (env)
// Presets:
//   single   -> 1 rep (default, backward compatible)
//   standard -> 3 reps
// An explicit INPUT_REPS always wins over a preset; a preset only applies when
// INPUT_REPS is unset/empty, keeping reps=1 single-run behavior the default.
//
// Output: writes `matrix=<json>` to $GITHUB_OUTPUT (or stdout for local dev).

import * as fs from "node:fs";
import { LAYER_NAMES } from "./bench-paths.mjs";

const DEFAULT_LAYERS = LAYER_NAMES.filter((n) => n !== "baseline" && n !== "all-on")
  .concat(["baseline", "all-on"]);

const REPS_PRESETS = Object.freeze({ single: 1, standard: 3 });

function splitCsv(s) {
  return (s ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const cliArgs = parseArgs(process.argv.slice(2));

function resolveReps() {
  const explicit = (process.env.INPUT_REPS ?? "").trim();
  if (explicit !== "") return Number(explicit);
  const presetName = (cliArgs["reps-preset"] ?? process.env.BENCH_REPS_PRESET ?? "").trim();
  if (presetName === "") return 1;
  if (!Object.prototype.hasOwnProperty.call(REPS_PRESETS, presetName)) {
    console.error(`expand-bench-matrix: unknown reps preset '${presetName}' (allowed: ${Object.keys(REPS_PRESETS).join(", ")})`);
    process.exit(2);
  }
  return REPS_PRESETS[presetName];
}

const layers = splitCsv(process.env.INPUT_LAYERS);
const oses = splitCsv(process.env.INPUT_OSES);
const reps = resolveReps();

const finalLayers = layers.length ? layers : DEFAULT_LAYERS;
const finalOses = oses.length ? oses : ["ubuntu-24.04"];

for (const l of finalLayers) {
  if (!LAYER_NAMES.includes(l)) {
    console.error(`expand-bench-matrix: unknown layer '${l}' (allowed: ${LAYER_NAMES.join(", ")})`);
    process.exit(2);
  }
}
if (!Number.isInteger(reps) || reps < 1) {
  console.error(`expand-bench-matrix: invalid reps=${reps} (from INPUT_REPS=${process.env.INPUT_REPS ?? ""}, BENCH_REPS_PRESET=${process.env.BENCH_REPS_PRESET ?? ""}, --reps-preset=${cliArgs["reps-preset"] ?? ""})`);
  process.exit(2);
}

const include = [];
for (const os of finalOses) {
  for (const layer of finalLayers) {
    for (let rep = 1; rep <= reps; rep++) {
      include.push({ os, layer, rep });
    }
  }
}

const matrix = { include };
const json = JSON.stringify(matrix);

const ghOut = process.env.GITHUB_OUTPUT;
if (ghOut) {
  fs.appendFileSync(ghOut, `matrix=${json}\n`, "utf8");
  console.log(`wrote matrix=${json} to $GITHUB_OUTPUT (${include.length} cells)`);
} else {
  console.log(json);
}
