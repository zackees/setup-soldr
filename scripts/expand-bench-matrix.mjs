// expand-bench-matrix.mjs — parse workflow_dispatch inputs into a GitHub
// Actions matrix include[] list.
//
// Inputs (all comma-separated strings, read from env):
//   INPUT_LAYERS  default: all eight layer names
//   INPUT_OSES    default: ubuntu-24.04
//   INPUT_REPS    default: 1
//
// Output: writes `matrix=<json>` to $GITHUB_OUTPUT (or stdout for local dev).

import * as fs from "node:fs";
import { LAYER_NAMES } from "./bench-paths.mjs";

const DEFAULT_LAYERS = LAYER_NAMES.filter((n) => n !== "baseline" && n !== "all-on")
  .concat(["baseline", "all-on"]);

function splitCsv(s) {
  return (s ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

const layers = splitCsv(process.env.INPUT_LAYERS);
const oses = splitCsv(process.env.INPUT_OSES);
const reps = Number(process.env.INPUT_REPS ?? "1");

const finalLayers = layers.length ? layers : DEFAULT_LAYERS;
const finalOses = oses.length ? oses : ["ubuntu-24.04"];

for (const l of finalLayers) {
  if (!LAYER_NAMES.includes(l)) {
    console.error(`expand-bench-matrix: unknown layer '${l}' (allowed: ${LAYER_NAMES.join(", ")})`);
    process.exit(2);
  }
}
if (!Number.isInteger(reps) || reps < 1) {
  console.error(`expand-bench-matrix: invalid INPUT_REPS=${process.env.INPUT_REPS}`);
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
