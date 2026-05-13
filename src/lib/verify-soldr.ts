// Soldr smoke-test. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/verify_soldr.py.
// Runs `soldr version --json` and asserts the binary is on PATH, returns
// the resolved version string for the action output.

export interface VerifyResult {
  soldrVersion: string;
}

export async function verifySoldr(opts: {
  soldrPath: string;
  buildCacheMode: string;
  requireRustPlan: boolean;
}): Promise<VerifyResult> {
  void opts;
  throw new Error("not implemented: verifySoldr");
}
