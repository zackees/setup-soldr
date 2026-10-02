// setup-soldr#553: keep soldr's syslib/toolchain store in RUNNER_TOOL_CACHE.
//
// `soldr prepare` (and `soldr build`) install syslib bundles -- zstd, sqlite,
// zlib-ng, lzma, bzip2, cmake, ninja, the GNU/Linux GCC toolchain -- under
// `$SOLDR_CACHE_DIR/bin/syslib/<lib>/<version>/<slug>/`. setup-soldr puts
// SOLDR_CACHE_DIR under RUNNER_TEMP, which is empty in every new container, so
// under act (`bosn ci`) every warm run re-downloaded the whole set (35-77 s).
//
// On runners whose tool cache outlives the job (act with a persisted
// /opt/hostedtoolcache, self-hosted runners) we point `bin/syslib` at
// `$RUNNER_TOOL_CACHE/soldr-syslib/<platform>-<arch>`. Sharing that store is
// safe because soldr owns its integrity:
//   - every bundle is sha256-verified against the soldr-toolchain catalogue
//     before it is extracted;
//   - extraction happens in a staging dir next to the install and is
//     promoted atomically, with a `.complete` stamp written last;
//   - a cross-process lock in the syslib dir serializes concurrent installs;
//   - install paths are versioned (`<lib>/<version>/<slug>`), so a new
//     version lands beside the old one instead of over it.
// Only the syslib store moves; SOLDR_CACHE_DIR, zccache, and the rest of
// `bin/` stay where they were.
//
// Off by default on GitHub-hosted runners: their tool cache dies with the VM,
// and setup-cache already carries `$SOLDR_CACHE_DIR/bin` (syslib included)
// there -- a symlink in its place would make setup-cache save a pointer
// instead of the content. Off when setup-soldr runs `soldr prepare` itself
// (`cross-targets`): that lane's prepare archive already persists syslib, and
// soldr's restore refuses to unpack through a link leaving its root.

import * as fs from "node:fs";
import * as path from "node:path";

export const SYSLIB_TOOL_CACHE_ENV = "SETUP_SOLDR_SYSLIB_TOOL_CACHE";
export const SYSLIB_STORE_ENV = "SETUP_SOLDR_SYSLIB_STORE";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface SyslibToolCacheDecision {
  enabled: boolean;
  store: string;
  reason: string;
}

export function syslibToolCacheStore(toolCache: string, platform: string, arch: string): string {
  return path.join(toolCache, "soldr-syslib", `${platform}-${arch}`);
}

export function decideSyslibToolCache(input: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  crossPrepareTarget: string;
}): SyslibToolCacheDecision {
  const toolCache = (input.env["RUNNER_TOOL_CACHE"] ?? "").trim();
  const store = toolCache ? syslibToolCacheStore(toolCache, input.platform, input.arch) : "";
  const off = (reason: string): SyslibToolCacheDecision => ({ enabled: false, store, reason });
  const override = (input.env[SYSLIB_TOOL_CACHE_ENV] ?? "").trim().toLowerCase();

  if (FALSY.has(override)) return off(`${SYSLIB_TOOL_CACHE_ENV}=${override}`);
  if (!toolCache) return off("RUNNER_TOOL_CACHE is unset");
  // Windows would need a junction, and soldr's Windows extractors already
  // special-case reparse points (soldr#2300); keep it out until proven there.
  if (input.platform === "win32") return off("not enabled on Windows");
  if (input.crossPrepareTarget.trim()) {
    return off("cross-targets prepare cache already persists syslib for this lane");
  }
  if (TRUTHY.has(override)) return { enabled: true, store, reason: `${SYSLIB_TOOL_CACHE_ENV}=${override}` };
  if (TRUTHY.has((input.env["ACT"] ?? "").trim().toLowerCase())) {
    return { enabled: true, store, reason: "act runner (tool cache persists across runs)" };
  }
  if ((input.env["RUNNER_ENVIRONMENT"] ?? "").trim() === "self-hosted") {
    return { enabled: true, store, reason: "self-hosted runner (tool cache persists across runs)" };
  }
  return off("GitHub-hosted tool cache is per-VM; setup-cache carries bin/syslib");
}

export type SyslibLinkStatus = "linked" | "already-linked" | "kept-existing-dir";

/**
 * Make `<soldrBinDir>/syslib` a symlink to `store`. A non-empty real
 * directory (for example one setup-cache just restored) is left alone: it
 * already holds the content, and replacing it would discard it.
 */
export function linkSyslibToolCache(input: { soldrBinDir: string; store: string }): {
  status: SyslibLinkStatus;
  syslibDir: string;
  store: string;
} {
  const syslibDir = path.join(input.soldrBinDir, "syslib");
  const store = input.store;
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(input.soldrBinDir, { recursive: true });

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(syslibDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing?.isSymbolicLink()) {
    if (fs.readlinkSync(syslibDir) === store) return { status: "already-linked", syslibDir, store };
    fs.unlinkSync(syslibDir);
  } else if (existing?.isDirectory()) {
    if (fs.readdirSync(syslibDir).length > 0) return { status: "kept-existing-dir", syslibDir, store };
    fs.rmdirSync(syslibDir);
  } else if (existing) {
    fs.unlinkSync(syslibDir);
  }
  fs.symlinkSync(store, syslibDir, "dir");
  return { status: "linked", syslibDir, store };
}
