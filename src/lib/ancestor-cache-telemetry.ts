import type { AncestorKey, AncestorSelection } from "./ancestor-cache.js";

export interface AncestorRestorePlan {
  writeKey: string;
  selection: AncestorSelection;
  writer: AncestorKey;
  ref: string;
  elapsedMs: number;
  requests: number;
  apiMs: number;
  rateLimitRemaining: number | null;
  /** Local runner only: restore the newest same-identity entry by prefix. */
  restorePrefix?: string;
  /** Local runner only: when no same-identity entry exists, restore the
   * newest entry of the same toolchain/job family (setup-soldr#575). */
  familyPrefix?: string;
}

export interface AncestorTelemetry {
  selected_cache_id: number | null;
  selected_key: string;
  write_key: string;
  identity: string;
  distance: number | null;
  source_sha: string;
  reason: string;
  scan_ms: number;
  api_ms: number;
  requests: number;
  rate_limit_remaining: number | null;
}

/** Count an API operation only after admitting it. A rejected 25th lookup
 * must not be reported as a GET that was actually attempted. */
export function admitAncestorRequest(count: number, elapsedMs: number): number {
  if (elapsedMs > 45_000 || count >= 24) throw new Error("ancestor lookup exceeded time/request budget");
  return count + 1;
}

export function ancestorTelemetry(identity: string, plan: AncestorRestorePlan): AncestorTelemetry {
  return {
    selected_cache_id: plan.selection.entry?.id ?? null,
    selected_key: plan.selection.entry?.key ?? "",
    write_key: plan.writeKey,
    identity,
    distance: plan.selection.distance,
    source_sha: plan.writer.sha,
    reason: plan.selection.reason,
    scan_ms: plan.elapsedMs,
    api_ms: plan.apiMs,
    requests: plan.requests,
    rate_limit_remaining: plan.rateLimitRemaining,
  };
}

/** Resolve emits a legacy key before auto/explicit selection. Re-publish the
 * actual write key after selection, together with structured donor telemetry.
 * Selection is prospective: matched-key output proves actual usable restore. */
export function publishBuildCachePlan(
  writeKey: string, telemetry: AncestorTelemetry | null,
  emit: (name: string, value: string) => void,
): void {
  emit("build-cache-key", writeKey);
  emit("build-cache-ancestor-json", telemetry ? JSON.stringify(telemetry) : "");
}
