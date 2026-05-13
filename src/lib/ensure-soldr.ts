// Soldr binary installer. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/ensure_soldr.py.
// Downloads the soldr binary from a GitHub release asset (or builds from a
// git ref when INPUT_REF is set) and places it under $SOLDR_INSTALL_DIR.

import type { ResolveResult } from "./types.js";

export async function ensureSoldr(opts: {
  resolveResult: ResolveResult;
  githubToken: string;
}): Promise<void> {
  void opts;
  throw new Error("not implemented: ensureSoldr");
}
