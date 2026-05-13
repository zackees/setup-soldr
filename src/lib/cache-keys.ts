// Cache key derivation helpers. Owned by Agent 1.
//
// Port of resolve_setup.py:
//   - _workspace_manifest_hash()
//   - _cargo_config_hash()
//   - _target_env_hash()
//   - _short_json_hash()
//   - _short_file_hash()
//   - _sanitize_fragment()
//   - normalize_build_cache_mode()
//   - normalize_target_cache_profile()
//   - normalize_target_cache_bool()
//   - normalize_target_cache_compress()
//   - normalize_target_cache_compress_level()
//   - _target_cache_soft_budget()
//   - _setup_cache_paths(), _setup_cache_layout()
//   - resolve_lockfile_path()
//
// All cache key derivation must be byte-identical to the Python output to
// avoid invalidating warm caches on existing consumer workflows. The
// tests/test_resolve_setup_*.py suite is the authoritative oracle for the
// expected key shapes.

export function shortJsonHash(value: Record<string, unknown>): string {
  void value;
  throw new Error("not implemented: shortJsonHash");
}

export async function shortFileHash(path: string, missing: string): Promise<string> {
  void path;
  void missing;
  throw new Error("not implemented: shortFileHash");
}

export function sanitizeFragment(value: string): string {
  void value;
  throw new Error("not implemented: sanitizeFragment");
}

export async function workspaceManifestHash(workspace: string): Promise<string> {
  void workspace;
  throw new Error("not implemented: workspaceManifestHash");
}

export async function cargoConfigHash(workspace: string): Promise<string> {
  void workspace;
  throw new Error("not implemented: cargoConfigHash");
}

export function targetEnvHash(env: Record<string, string | undefined>): string {
  void env;
  throw new Error("not implemented: targetEnvHash");
}

export function normalizeTargetCacheProfile(value: string): "thin-v1" | "thin-v2" {
  void value;
  throw new Error("not implemented: normalizeTargetCacheProfile");
}

export function normalizeTargetCacheBool(inputName: string, value: string): "true" | "false" | null {
  void inputName;
  void value;
  throw new Error("not implemented: normalizeTargetCacheBool");
}

export function normalizeBuildCacheMode(
  value: string,
  legacyTargetMode: string,
  allowLegacyTranslation: boolean,
): "once" | "thin" | "full" {
  void value;
  void legacyTargetMode;
  void allowLegacyTranslation;
  throw new Error("not implemented: normalizeBuildCacheMode");
}

export function normalizeTargetCacheCompress(value: string): "auto" | "zstd" | "none" {
  void value;
  throw new Error("not implemented: normalizeTargetCacheCompress");
}

export function normalizeTargetCacheCompressLevel(value: string): string {
  void value;
  throw new Error("not implemented: normalizeTargetCacheCompressLevel");
}
