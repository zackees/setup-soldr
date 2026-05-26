// render-bench-summary.mjs — render collated CSV to a markdown table suitable
// for $GITHUB_STEP_SUMMARY. Usage:
//   node scripts/render-bench-summary.mjs <matrix-csv>

import * as fs from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: render-bench-summary.mjs <csv>"); process.exit(2); }
const text = fs.readFileSync(file, "utf8").trim();
const lines = text.split(/\r?\n/);
if (lines.length < 2) {
  console.log("_(no rows)_");
  process.exit(0);
}

const header = lines[0].split(",");
const rows = lines.slice(1).map((l) => l.split(","));

const out = [];
out.push(`## Cache-mode benchmark — ${rows.length} row(s)`);
out.push("");
out.push("| " + header.join(" | ") + " |");
out.push("|" + header.map(() => "---").join("|") + "|");
for (const r of rows) {
  out.push("| " + r.join(" | ") + " |");
}

// Quick "what to retire" hint section.
out.push("");
out.push("### Retirement candidates (per issue §criteria)");
out.push("");
out.push("Layers flagged below trip at least one threshold:");
out.push("- `net_benefit_s ≤ 2` (restore costs more than half the speedup)");
out.push("- `inflated_mb > 500` AND `speedup_s < 5`");
out.push("");
const flags = [];
const colNet = header.indexOf("net_benefit_s");
const colSpeed = header.indexOf("speedup_s");
const colSize = header.indexOf("inflated_mb");
const colLayer = header.indexOf("layer");
const colPhase = header.indexOf("phase");
for (const r of rows) {
  // Only the warm row carries the derived columns; cold/mech rows leave
  // speedup_s and net_benefit_s empty and would otherwise be spuriously
  // flagged as "no benefit".
  if (r[colPhase] !== "warm") continue;
  const layer = r[colLayer];
  const netRaw = r[colNet];
  const speedRaw = r[colSpeed];
  const sizeRaw = r[colSize];
  const net = netRaw === "" ? NaN : Number(netRaw);
  const speed = speedRaw === "" ? NaN : Number(speedRaw);
  const size = sizeRaw === "" ? NaN : Number(sizeRaw);
  const reasons = [];
  if (Number.isFinite(net) && net <= 2) reasons.push(`net_benefit_s=${net}`);
  if (Number.isFinite(size) && size > 500 && Number.isFinite(speed) && speed < 5) {
    reasons.push(`inflated_mb=${size}, speedup_s=${speed}`);
  }
  if (reasons.length) flags.push(`- **${layer}** — ${reasons.join("; ")}`);
}
if (flags.length === 0) out.push("_None flagged — all layers cleared the thresholds._");
else out.push(...flags);
out.push("");

process.stdout.write(out.join("\n") + "\n");
