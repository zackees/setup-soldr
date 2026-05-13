// Toolchain resolution helpers. Owned by Agent 1.
//
// Port of resolve_setup.py:
//   - load_toolchain_spec()
//   - _rolling_toolchain_alias()
//   - _rust_channel_manifest_release()
//   - resolve_toolchain_cache_channel()

import type { ToolchainSpec } from "./types.js";

/**
 * Load toolchain spec from rust-toolchain.toml (or input override).
 * `workspace` is the consumer's $GITHUB_WORKSPACE. `toolchainFile` is the
 * filename to look for relative to workspace. `toolchainOverride` is the raw
 * INPUT_TOOLCHAIN value (empty string when unset).
 */
export async function loadToolchainSpec(opts: {
  workspace: string;
  toolchainFile: string;
  toolchainOverride: string;
}): Promise<ToolchainSpec> {
  void opts;
  throw new Error("not implemented: loadToolchainSpec");
}

/**
 * Resolve a rolling channel alias ("stable", "beta", "nightly") to the
 * concrete release version (e.g. "1.95.0") by fetching the rust manifest
 * from static.rust-lang.org. Returns the input channel string unchanged for
 * non-rolling channels or on fetch failure.
 */
export async function resolveToolchainCacheChannel(channel: string): Promise<string> {
  void channel;
  throw new Error("not implemented: resolveToolchainCacheChannel");
}
