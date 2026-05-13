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
