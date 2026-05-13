// Shared target/ warning detector. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/detect_shared_target_warning.py.
// Emits a ::warning:: when the user's target-dir overlaps with another
// caching layer (e.g. a workflow-level actions/cache step) that would
// double-save the directory.

export async function detectSharedTargetWarning(opts: {
  buildCacheEnabled: boolean;
  effectiveTargetCacheEnabled: boolean;
  buildCacheMode: string;
  targetDir: string;
}): Promise<void> {
  void opts;
  throw new Error("not implemented: detectSharedTargetWarning");
}
