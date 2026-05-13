// Source mtime normalizer. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/normalize_source_mtime.py.
// Rewrites the mtime of tracked Rust build-input files to each file's
// last-commit timestamp so cargo fingerprints stay stable across fresh
// checkouts of the same SHA.

export async function normalizeSourceMtime(opts: {
  workspace: string;
  enabled: boolean;
}): Promise<void> {
  void opts;
  throw new Error("not implemented: normalizeSourceMtime");
}
