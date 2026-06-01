// Repo-level Actions Cache eviction with priority tiers.
//
// Motivation (setup-soldr#346/#347): the small long-lived caches that
// deliver the biggest warm-CI wins (solo-toolchain, cargo-registry,
// soldr-mini, setup-cache) get LRU-evicted when the repo's cache
// usage exceeds GitHub's 10 GB soft cap. The eviction is dominated by
// per-commit large entries (cook-delta up to 2 GB, build-cache per
// platform-job, zccache test/bench artifacts). Result: macOS Check
// wall clock regressed from 34s → 81s on zccache.
//
// This module runs in setup-soldr's post-step and proactively deletes
// the OLDEST evictable entries until usage is under target, while
// NEVER touching the foundation prefixes.
//
// Tradeoffs:
//   - Needs `actions: write` permission on GITHUB_TOKEN. Without it,
//     deleteActionsCacheById returns 403; we log a warning once and
//     continue (action does not fail).
//   - Concurrent parallel jobs all run this in their post-steps,
//     possibly racing on the same delete. 404 is tolerated.
//   - Foundation prefixes are a hardcoded allowlist. New foundation
//     layers must be added explicitly here when introduced.

import * as github from "@actions/github";

/**
 * Cache-key prefixes for FOUNDATION layers that must NEVER be
 * evicted by this routine. These are small (< 250 MB each) and
 * long-lived; each one delivers ~5-15 s/warm-job wall-clock when hit.
 */
export const FOUNDATION_PREFIXES: readonly string[] = [
  "solo-toolchain-v", // ~170 MB, skips ~8-11 s rustup install
  "soldr-mini-", // ~11 MB, skips soldr binary download
  "setup-soldr-v", // tiny setup-cache
  "setup-soldr-cargoregistry-v", // ~50 MB, skips crate-source download
];

export type CacheEvictionPolicy = "disabled" | "protect-foundations" | "aggressive";

export interface CacheEvictionThresholds {
  /** Eviction fires when usage exceeds this. GB. */
  triggerGb: number;
  /** Eviction continues until usage is at or below this. GB. */
  targetGb: number;
}

export function thresholdsForPolicy(policy: CacheEvictionPolicy): CacheEvictionThresholds | null {
  switch (policy) {
    case "disabled":
      return null;
    case "protect-foundations":
      return { triggerGb: 8, targetGb: 7 };
    case "aggressive":
      return { triggerGb: 6, targetGb: 5 };
  }
}

export interface CacheEntry {
  id: number;
  key?: string;
  size_in_bytes: number;
  created_at: string;
}

export interface EvictDeps {
  /** Repo identity. */
  owner: string;
  repo: string;
  /** GitHub token with `actions: write`. */
  token: string;
  /** Override thresholds (otherwise derived from policy). */
  overrideThresholds?: CacheEvictionThresholds;
  /** Logger. */
  log: (msg: string) => void;
  /** Test seam — list caches. */
  listCaches?: () => Promise<CacheEntry[]>;
  /** Test seam — total bytes. */
  getUsageBytes?: () => Promise<number>;
  /** Test seam — delete. */
  deleteCacheById?: (cacheId: number) => Promise<void>;
}

export interface EvictResult {
  fired: boolean;
  reason?: string;
  usageBeforeGb?: number;
  usageAfterGb?: number;
  deletedCount?: number;
  deletedBytes?: number;
}

/**
 * Run an eviction pass. Returns a summary suitable for logging.
 * Never throws on permission/network errors — best-effort.
 */
export async function evictIfOverBudget(
  policy: CacheEvictionPolicy,
  deps: EvictDeps,
): Promise<EvictResult> {
  const thresholds = deps.overrideThresholds ?? thresholdsForPolicy(policy);
  if (!thresholds) {
    return { fired: false, reason: "policy=disabled" };
  }
  const { owner, repo, token, log } = deps;

  // Default API impls use @actions/github octokit.
  const octokit = github.getOctokit(token);
  const listCaches: NonNullable<EvictDeps["listCaches"]> =
    deps.listCaches ??
    (async () => {
      const all: CacheEntry[] = [];
      let page = 1;
      // Use paginate-via-loop to keep behavior explicit + testable.
      while (true) {
        const resp = await octokit.rest.actions.getActionsCacheList({
          owner,
          repo,
          per_page: 100,
          page,
          sort: "created_at",
          direction: "asc",
        });
        const items = resp.data.actions_caches ?? [];
        for (const c of items) {
          if (c.id != null && c.size_in_bytes != null && c.created_at != null) {
            all.push({
              id: c.id,
              key: c.key,
              size_in_bytes: c.size_in_bytes,
              created_at: c.created_at,
            });
          }
        }
        if (items.length < 100) break;
        page += 1;
      }
      return all;
    });
  const getUsageBytes: NonNullable<EvictDeps["getUsageBytes"]> =
    deps.getUsageBytes ??
    (async () => {
      const resp = await octokit.rest.actions.getActionsCacheUsage({ owner, repo });
      return resp.data.active_caches_size_in_bytes ?? 0;
    });
  const deleteCacheById: NonNullable<EvictDeps["deleteCacheById"]> =
    deps.deleteCacheById ??
    (async (cacheId) => {
      await octokit.rest.actions.deleteActionsCacheById({ owner, repo, cache_id: cacheId });
    });

  let usageBytes: number;
  try {
    usageBytes = await getUsageBytes();
  } catch (err) {
    log(`cache-eviction: skipping — usage API call failed: ${err instanceof Error ? err.message : String(err)}`);
    return { fired: false, reason: `usage-api-failed: ${err instanceof Error ? err.message : err}` };
  }
  const usageBeforeGb = usageBytes / 1024 / 1024 / 1024;
  if (usageBeforeGb <= thresholds.triggerGb) {
    log(
      `cache-eviction: ${usageBeforeGb.toFixed(2)} GB <= ${thresholds.triggerGb} GB trigger — no action (policy=${policy})`,
    );
    return {
      fired: false,
      reason: "under-trigger",
      usageBeforeGb,
      usageAfterGb: usageBeforeGb,
      deletedCount: 0,
      deletedBytes: 0,
    };
  }
  log(
    `cache-eviction: ${usageBeforeGb.toFixed(2)} GB > ${thresholds.triggerGb} GB trigger — evicting toward ${thresholds.targetGb} GB target (policy=${policy})`,
  );

  let caches: CacheEntry[];
  try {
    caches = await listCaches();
  } catch (err) {
    log(`cache-eviction: list API call failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      fired: false,
      reason: `list-api-failed: ${err instanceof Error ? err.message : err}`,
      usageBeforeGb,
    };
  }
  const evictable = caches
    .filter((c) => !!c.key && !FOUNDATION_PREFIXES.some((p) => c.key!.startsWith(p)))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const targetBytes = thresholds.targetGb * 1024 * 1024 * 1024;
  let bytes = usageBytes;
  let deleted = 0;
  let deletedBytes = 0;
  let permissionDeniedLogged = false;
  for (const c of evictable) {
    if (bytes <= targetBytes) break;
    try {
      await deleteCacheById(c.id);
      bytes -= c.size_in_bytes;
      deleted += 1;
      deletedBytes += c.size_in_bytes;
      log(
        `cache-eviction: deleted ${c.key} (${(c.size_in_bytes / 1024 / 1024).toFixed(0)} MB, ` +
          `age ${((Date.now() - new Date(c.created_at).getTime()) / 3600000).toFixed(1)}h)`,
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) continue; // raced with another job's delete; fine
      if (status === 403 || status === 401) {
        if (!permissionDeniedLogged) {
          log(
            `cache-eviction: permission denied (status=${status}) — workflow needs 'permissions: actions: write'. Skipping further deletes.`,
          );
          permissionDeniedLogged = true;
        }
        break; // no point trying more deletes
      }
      log(
        `cache-eviction: delete failed for ${c.key} (status=${status ?? "?"}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const usageAfterGb = bytes / 1024 / 1024 / 1024;
  log(
    `cache-eviction: complete — deleted ${deleted} entries (${(deletedBytes / 1024 / 1024 / 1024).toFixed(2)} GB), ` +
      `usage ~${usageBeforeGb.toFixed(2)} GB → ~${usageAfterGb.toFixed(2)} GB`,
  );
  return {
    fired: true,
    usageBeforeGb,
    usageAfterGb,
    deletedCount: deleted,
    deletedBytes,
  };
}
