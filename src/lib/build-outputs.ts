// $GITHUB_OUTPUT key/value mapping for setup-soldr. Pure function of
// the resolved state — split out of resolve-setup.ts to keep the
// orchestration module focused on input parsing / cache-key derivation.
// Mirrors resolve_setup.py's `_write_outputs()` call so tests can
// assert byte-for-byte.

import type { ResolveResult } from "./types.js";

/**
 * Build the $GITHUB_OUTPUT key/value map. Exposed for tests so they
 * can assert byte-for-byte parity with the legacy Python action's
 * `_write_outputs()` call.
 */
export function buildOutputs(result: ResolveResult): Record<string, string> {
  return {
    cache_root: result.cacheRoot,
    setup_cache_path: result.setupCache.setupCachePath,
    setup_cache_paths: result.setupCache.paths.join("\n"),
    cache_key: result.setupCache.key,
    cache_restore_prefix: result.setupCache.restorePrefix,
    build_cache_key: result.buildCache.key,
    build_cache_restore_key_parent: result.buildCache.restoreKeyParent,
    build_cache_restore_key_toolchain: result.buildCache.restoreKeyToolchain,
    build_cache_restore_key_os_arch: result.buildCache.restoreKeyOsArch,
    build_cache_path: result.buildCache.path,
    build_cache_mode: result.buildCache.mode,
    target_cache_path: result.targetCache.targetPath,
    target_cache_bundle_path: result.targetCache.bundlePath,
    target_cache_paths: result.targetCache.paths,
    target_cache_enabled: result.targetCache.enabled ? "true" : "false",
    target_cache_mode: result.targetCache.effectiveMode,
    target_cache_profile: result.targetCache.profile,
    target_cache_compress: result.targetCacheCompress,
    target_cache_compress_level: result.targetCacheCompressLevel,
    target_cache_key: result.targetCache.key,
    target_cache_restore_key_parent: result.targetCache.restoreKeyParent,
    target_cache_restore_key_lock: result.targetCache.restoreKeyLock,
    target_cache_restore_key_lockfile: result.targetCache.restoreKeyLockfile,
    target_cache_budget_bytes: result.targetCache.budgetBytes,
    target_cache_budget_files: result.targetCache.budgetFiles,
    target_lockfile_path: result.targetCache.lockfilePath,
    target_lockfile_hash: result.targetCache.lockfileHash,
    cargo_registry_cache_enabled: result.cargoRegistryCache.enabled ? "true" : "false",
    cargo_registry_cache_path: result.cargoRegistryCache.path,
    cargo_registry_cache_key: result.cargoRegistryCache.key,
    cargo_registry_cache_restore_prefix: result.cargoRegistryCache.restorePrefix,
    soldr_root: result.soldrRoot,
    soldr_bin_cache_path: result.soldrBinCachePath,
    cargo_home: result.cargoHome,
    rustup_home: result.rustupHome,
    setup_cache_layout: result.setupCache.layout,
    bin_dir: result.binDir,
    shims_dir: result.shimsDir,
    soldr_path: result.soldrPath,
    soldr_repo: result.soldrRepo,
    soldr_ref: result.soldrRef,
    soldr_version_requested: result.soldrVersionRequested,
    soldr_version_resolved: result.soldrVersionResolved,
    toolchain_channel: result.toolchain.channel,
    toolchain_cache_channel: result.toolchain.cacheChannel,
    toolchain_profile: result.toolchain.profile,
    toolchain_source: result.toolchain.source,
    toolchain: result.toolchain.channel,
    enabled: result.enabled ? "true" : "false",
  };
}
