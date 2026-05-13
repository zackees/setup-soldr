// Phase timing helpers. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/phase_timing.py.
// Records SETUP_SOLDR_PHASE_<NAME>_START_MS in $GITHUB_ENV on `mark`, and on
// `finish` computes elapsed seconds and writes them to $GITHUB_OUTPUT.

export async function markPhase(phase: string): Promise<void> {
  void phase;
  throw new Error("not implemented: markPhase");
}

export async function finishPhase(phase: string): Promise<number> {
  void phase;
  throw new Error("not implemented: finishPhase");
}
