// Rustup / toolchain installer. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/ensure_rust_toolchain.py.
// Bootstraps rustup if missing, installs the requested channel + components
// + targets, and ensures the toolchain is ready for downstream cargo calls.

import type { ResolveResult } from "./types.js";

export async function ensureRustToolchain(opts: {
  resolveResult: ResolveResult;
  setupCacheExactHit: boolean;
}): Promise<void> {
  void opts;
  throw new Error("not implemented: ensureRustToolchain");
}
