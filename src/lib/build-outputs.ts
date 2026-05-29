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
 *
 * Naming: emits the kebab-case names declared in action.yml so that
 * `${{ steps.<id>.outputs.<name> }}` references in downstream workflow
 * steps resolve to non-empty values. zackees/setup-soldr#125 was a
 * regression where this map used underscored Python-port keys that
 * never matched the hyphenated action.yml declarations, leaving every
 * scalar output empty in consuming workflows.
 *
 * A handful of underscored aliases are emitted in parallel for
 * backwards compatibility with internal callers that hard-coded the
 * old names (none known externally; action.yml only declared the
 * hyphenated forms). Treat the underscored aliases as legacy — remove
 * them after a deprecation window once we've confirmed nothing
 * downstream relies on them.
 */
export function buildOutputs(result: ResolveResult): Record<string, string> {
  // Canonical kebab-case outputs (these are the ones declared in action.yml
  // and the names users should reference). Adding a new output? Put it here.
  const canonical: Record<string, string> = {
    "enabled": result.enabled ? "true" : "false",
    "soldr-path": result.soldrPath,
    "cache-dir": result.cacheRoot,
    "cache-key": result.setupCache.key,
    "build-cache-key": result.buildCache.key,
    "build-cache-path": result.buildCache.path,
    "build-cache-mode": result.buildCache.mode,
    "target-cache-key": result.targetCache.key,
    "target-cache-path": result.targetCache.targetPath,
    "target-cache-paths": result.targetCache.paths,
    "target-cache-mode": result.targetCache.effectiveMode,
    "target-cache-profile": result.targetCache.profile,
    "target-cache-compress": result.targetCacheCompress,
    "target-cache-compress-level": result.targetCacheCompressLevel,
    "target-cache-budget-bytes": result.targetCache.budgetBytes,
    "target-cache-budget-files": result.targetCache.budgetFiles,
    "target-lockfile": result.targetCache.lockfilePath,
    "target-lockfile-hash": result.targetCache.lockfileHash,
    "dylint-cache-key": result.dylintCache.key,
    "dylint-driver-path": result.dylintCache.driverPath,
    "shims-dir": result.shimsDir,
    "toolchain": result.toolchain.channel,
    "cache-preset-effective": result.cachePresetEffective,
  };

  // Legacy underscored aliases retained for backwards compatibility with
  // any consumer that latched onto the old Python-port output names from
  // before #125 (most of these were never declared in action.yml so
  // technically undocumented, but free to keep around).
  const legacy: Record<string, string> = {
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
    dylint_cache_enabled: result.dylintCache.enabled ? "true" : "false",
    dylint_cache_key: result.dylintCache.key,
    dylint_driver_path: result.dylintCache.driverPath,
    dylint_host_triple: result.dylintCache.hostTriple,
    dylint_toolchain: result.dylintCache.toolchain,
    dylint_driver_rev: result.dylintCache.driverRev,
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
  };

  return { ...legacy, ...canonical };
}
