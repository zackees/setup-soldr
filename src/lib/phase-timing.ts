// Phase timing helpers. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/phase_timing.py.
// Records SETUP_SOLDR_PHASE_<NAME>_START_MS in $GITHUB_ENV on `mark`, and on
// `finish` computes elapsed seconds and writes them to $GITHUB_OUTPUT.

import * as core from "@actions/core";

function phaseEnvName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "PHASE";
  return `SETUP_SOLDR_PHASE_${cleaned}_START_MS`;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Record the start time of `phase` to $GITHUB_ENV. The orchestrator can read
 * the env var back in a later step (via `process.env`) or via `finishPhase`.
 */
export async function markPhase(phase: string): Promise<void> {
  const name = phaseEnvName(phase);
  const value = String(nowMs());
  core.exportVariable(name, value);
  // exportVariable updates process.env so finishPhase in the same JS process
  // can read it. No-op when GITHUB_ENV is not set.
}

/**
 * Compute the elapsed seconds for `phase` and write it to $GITHUB_OUTPUT
 * as `seconds=<n>`. Returns the elapsed seconds value.
 */
export async function finishPhase(phase: string): Promise<number> {
  const name = phaseEnvName(phase);
  const startRaw = (process.env[name] ?? "").trim();
  let startMs = 0;
  if (startRaw) {
    const parsed = Number(startRaw);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      startMs = Math.floor(parsed);
    }
  }
  const elapsedMs = startMs ? Math.max(0, nowMs() - startMs) : 0;
  const seconds = elapsedMs / 1000;
  const formatted = seconds.toFixed(3);
  core.setOutput(`${phase}_seconds`, formatted);
  core.setOutput(`${phase}_milliseconds`, String(elapsedMs));
  return seconds;
}

/**
 * Read every recorded SETUP_SOLDR_PHASE_*_START_MS env var (in the
 * declared order) and produce a one-line aggregate of how long each
 * phase took. Durations are computed as the delta between adjacent
 * phase start times; the final phase's duration is `now - phase_start`.
 *
 * Mirrors the post-step `cache save totals:` line from
 * `StatsCollector.saveSummaryOneLine()`. Surfaces the pre-build
 * budget at a glance instead of requiring operators to read raw
 * SETUP_SOLDR_PHASE_*_START_MS env vars or scroll the timeline.
 *
 * Returns "" when no phase start markers are present (e.g. test
 * harness running without env var infrastructure). Phases whose env
 * var isn't set are silently skipped (passthrough mode, partial
 * runs, etc.).
 */
export function setupPhaseSummaryOneLine(orderedPhases: readonly string[]): string {
  const now = nowMs();
  const records: Array<{ name: string; startMs: number }> = [];
  for (const phase of orderedPhases) {
    const raw = (process.env[phaseEnvName(phase)] ?? "").trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) continue;
    records.push({ name: phase, startMs: Math.floor(parsed) });
  }
  if (records.length === 0) return "";

  // #302: include sub-phase breakdown inline `{sub=Xs sub=Ys}` when a
  // parent phase has any recorded sub-phases. Threshold-gated below so
  // skip-fast phases (zccache-seed=0.1s) don't add noise.
  const SUBPHASE_DISPLAY_THRESHOLD_MS = 1_000;
  const segments: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const cur = records[i]!;
    const endMs = i + 1 < records.length ? records[i + 1]!.startMs : now;
    const durMs = Math.max(0, endMs - cur.startMs);
    let seg = `${cur.name}=${(durMs / 1000).toFixed(1)}s`;
    if (durMs >= SUBPHASE_DISPLAY_THRESHOLD_MS) {
      const subs = readSubPhaseDurations(cur.name);
      if (subs.length > 0) {
        seg += ` {${subs.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(1)}s`).join(" ")}}`;
      }
    }
    segments.push(seg);
  }
  const totalMs = now - records[0]!.startMs;
  return `setup phase totals: ${segments.join(" ")} total=${(totalMs / 1000).toFixed(1)}s`;
}

function subPhaseEnvName(parent: string, name: string): string {
  const cleanParent = parent.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "PHASE";
  const cleanName = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "SUB";
  return `SETUP_SOLDR_PHASE_${cleanParent}_SUB_${cleanName}_MS`;
}

/**
 * Time the async/sync `body` as a sub-phase of `parent`. Records the
 * duration into `SETUP_SOLDR_PHASE_<parent>_SUB_<name>_MS` and returns
 * the body's result. Errors are propagated; the duration is still
 * recorded so failed sub-phases show up in the summary. (#302)
 */
export async function timeSubPhase<T>(
  parent: string,
  name: string,
  body: () => Promise<T> | T,
): Promise<T> {
  const start = nowMs();
  try {
    return await body();
  } finally {
    const ms = Math.max(0, nowMs() - start);
    // Aggregate across multiple calls with the same name (e.g. when a
    // sub-phase fires in a loop) by adding to the existing value.
    const env = subPhaseEnvName(parent, name);
    const prev = Number((process.env[env] ?? "").trim()) || 0;
    core.exportVariable(env, String(prev + ms));
  }
}

/** Read all SETUP_SOLDR_PHASE_<parent>_SUB_*_MS env vars for `parent`. */
function readSubPhaseDurations(parent: string): Array<[string, number]> {
  const cleanParent = parent.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "PHASE";
  const prefix = `SETUP_SOLDR_PHASE_${cleanParent}_SUB_`;
  const out: Array<[string, number]> = [];
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !key.endsWith("_MS")) continue;
    const name = key.slice(prefix.length, -"_MS".length).toLowerCase();
    const ms = Number((raw ?? "").trim());
    if (!Number.isFinite(ms) || ms <= 0) continue;
    out.push([name, ms]);
  }
  // Stable order: largest first so the slowest sub-phase reads first.
  out.sort((a, b) => b[1] - a[1]);
  return out;
}
