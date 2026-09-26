/**
 * Shared durable-cache save policy (setup-soldr#527).
 *
 * GitHub scopes a cache entry saved from a `pull_request` run to
 * `refs/pull/N/merge`: no other ref can restore it, yet it counts against
 * the repository's 10 GB budget and evicts the default branch's entries.
 * Every durable Actions-cache write in `src/` therefore goes through this
 * module, which decides from the `save-cache` input (`auto | true | false`)
 * and `GITHUB_EVENT_NAME` whether an upload may happen.
 *
 * - `auto` (default): save unless the triggering event is `pull_request`.
 * - `true`: always save (subject to each layer's own gates).
 * - `false`: never save.
 *
 * Restores and cooking are never gated here; only uploads are.
 *
 * `__tests__/save-policy.test.ts` enumerates every raw save call site in
 * `src/` and fails when one bypasses this gate.
 */
import * as cache from "@actions/cache";

export type SaveCacheMode = "auto" | "true" | "false";

export interface SaveDecision {
  save: boolean;
  mode: SaveCacheMode;
  /** Human-readable reason, used in the skip log line. */
  reason: string;
}

/** Status string layers report when the policy suppressed an upload. */
export const POLICY_SKIP_STATUS = "policy-skip" as const;

/**
 * Parse a `save-cache` input value. Empty means `defaultMode`; boolean
 * aliases keep the cook action's historical `true`/`false` spelling valid.
 */
export function parseSaveCacheMode(raw: string | undefined, defaultMode: SaveCacheMode = "auto"): SaveCacheMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return defaultMode;
  if (value === "auto") return "auto";
  if (["1", "true", "yes", "on"].includes(value)) return "true";
  if (["0", "false", "no", "off"].includes(value)) return "false";
  throw new Error(`save-cache must be one of auto, true, false (got '${raw}')`);
}

/** Pure decision: no I/O, platform independent (RUNNER_OS is irrelevant). */
export function decideCacheSave(mode: SaveCacheMode, eventName: string | undefined): SaveDecision {
  if (mode === "true") return { save: true, mode, reason: "save-cache=true" };
  if (mode === "false") return { save: false, mode, reason: "save-cache=false" };
  const event = (eventName ?? "").trim();
  if (event === "pull_request") {
    return { save: false, mode, reason: "pull_request event (save-cache=auto)" };
  }
  return { save: true, mode, reason: `${event || "unknown"} event (save-cache=auto)` };
}

/**
 * Resolve the policy from the process environment. Both the main action
 * and the `cook/` action expose the input as `save-cache`, which the runner
 * passes to main and post steps as `INPUT_SAVE-CACHE`.
 */
export function currentSaveDecision(env: NodeJS.ProcessEnv = process.env): SaveDecision {
  let mode: SaveCacheMode;
  try {
    mode = parseSaveCacheMode(env["INPUT_SAVE-CACHE"], "auto");
  } catch {
    mode = "auto";
  }
  return decideCacheSave(mode, env["GITHUB_EVENT_NAME"]);
}

const loggedSkips = new Set<string>();

/** Test hook: forget which layers already logged a skip line. */
export function resetSavePolicyLogForTest(): void {
  loggedSkips.clear();
}

/**
 * THE save gate. Returns true when `layer` may upload. When it may not,
 * logs one line per layer: `<layer>: save skipped: <reason>`.
 */
export function allowCacheSave(layer: string, log: (msg: string) => void = console.log): boolean {
  const decision = currentSaveDecision();
  if (decision.save) return true;
  if (!loggedSkips.has(layer)) {
    loggedSkips.add(layer);
    log(`${layer}: save skipped: ${decision.reason}`);
  }
  return false;
}

type SaveCacheFn = (paths: string[], key: string) => Promise<number>;
let saveBackend: SaveCacheFn = (paths, key) => cache.saveCache(paths, key);

/** Test hook: replace the `@actions/cache.saveCache` backend. */
export function setSaveCacheBackendForTest(fn: SaveCacheFn | null): void {
  saveBackend = fn ?? ((paths, key) => cache.saveCache(paths, key));
}

/**
 * Policy-gated replacement for `@actions/cache.saveCache`. Returns -1
 * (the same "not saved" sentinel @actions/cache uses) when the policy
 * forbids the upload. Callers should still gate early with
 * `allowCacheSave` so they skip archive production and report a clean
 * `policy-skip` status; this is the backstop.
 */
export async function gatedSaveCache(
  layer: string,
  paths: string[],
  key: string,
  log?: (msg: string) => void,
  backend?: SaveCacheFn,
): Promise<number> {
  if (!allowCacheSave(layer, log)) return -1;
  return (backend ?? saveBackend)(paths, key);
}
