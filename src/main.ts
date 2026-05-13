// setup-soldr entry point. Owned by Agent 2.
//
// Replaces the composite action's main-phase steps with a single JS
// orchestrator. Calls the helpers in src/lib/* in the same order the
// composite's steps fire.
//
// Outline of the equivalent composite-action flow (see git history for
// the deleted action.yml composite for reference):
//
//   1. phase-action-start: phaseTiming.mark("action")
//   2. phase-resolve-start: phaseTiming.mark("resolve")
//   3. resolve: resolveSetup() + applyResolveResult()
//   4. phase-resolve-end: phaseTiming.finish("resolve")
//   5. normalize-source-mtime (if enabled)
//   6. phase-setup-cache-start + cache-lookup + cache-restore/cache-managed
//   7. phase-target-cache-start + target-cache lookups + restore + managed
//   8. phase-build-cache-start + build-cache lookups + restore + managed
//   9. phase-target-tree-start + target-tree-cache (full mode only)
//  10. phase-toolchain-start + ensureRustToolchain
//  11. phase-install-start + ensureSoldr
//  12. phase-verify-start + verifySoldr
//  13. cache-meta: aggregate outputs, write summary
//  14. shared-target-warning

import * as core from "@actions/core";

async function run(): Promise<void> {
  void core;
  throw new Error("not implemented: setup-soldr main");
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  core.setFailed(`setup-soldr failed: ${message}`);
});
