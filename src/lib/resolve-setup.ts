// Top-level resolve-setup entry point. Owned by Agent 1.
//
// Full port of resolve_setup.py::main(). Reads INPUT_* / GITHUB_* env vars,
// resolves the toolchain spec, derives all cache keys, computes the env
// exports + outputs the orchestrator needs.
//
// The shape of the returned ResolveResult mirrors the $GITHUB_OUTPUT key set
// the Python script writes today. tests/test_resolve_setup_*.py is the
// authoritative oracle for the expected output set.

import type { ActionContext, RawInputs, ResolveResult } from "./types.js";

/**
 * Read all INPUT_* env vars into a typed struct. Empty strings for unset
 * inputs (mirrors GitHub Actions input semantics).
 */
export function readRawInputs(env: Record<string, string | undefined>): RawInputs {
  void env;
  throw new Error("not implemented: readRawInputs");
}

/**
 * Resolve setup state. The orchestrator calls this once at the start of the
 * action and uses the returned ResolveResult to drive every subsequent step.
 */
export async function resolveSetup(ctx: ActionContext, inputs: RawInputs): Promise<ResolveResult> {
  void ctx;
  void inputs;
  throw new Error("not implemented: resolveSetup");
}

/**
 * Apply ResolveResult to the runner: write $GITHUB_ENV, $GITHUB_PATH, and
 * $GITHUB_OUTPUT keys. Separate from resolveSetup() so tests can inspect the
 * computed plan without touching the runner.
 */
export async function applyResolveResult(result: ResolveResult): Promise<void> {
  void result;
  throw new Error("not implemented: applyResolveResult");
}
