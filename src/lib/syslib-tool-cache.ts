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

import * as path from "node:path";

import { decideToolCacheStore, linkDir, toolCacheStorePath, type LinkStatus } from "./tool-cache-store.js";

export const SYSLIB_STORE_ENV = "SETUP_SOLDR_SYSLIB_STORE";

export interface SyslibToolCacheDecision {
  enabled: boolean;
  store: string;
  reason: string;
}

export function syslibToolCacheStore(toolCache: string, platform: string, arch: string): string {
  return toolCacheStorePath(toolCache, "syslib", platform, arch);
}

export function decideSyslibToolCache(input: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  crossPrepareTarget: string;
}): SyslibToolCacheDecision {
  const decision = decideToolCacheStore({
    env: input.env,
    platform: input.platform,
    layerOff: input.crossPrepareTarget.trim()
      ? "cross-targets prepare cache already persists syslib for this lane"
      : "",
  });
  const store = decision.toolCache ? syslibToolCacheStore(decision.toolCache, input.platform, input.arch) : "";
  return { enabled: decision.enabled, store, reason: decision.reason };
}

export type SyslibLinkStatus = LinkStatus;

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
  return { status: linkDir({ linkPath: syslibDir, target: input.store }), syslibDir, store: input.store };
}
