// Pure input parsers / normalizers. Each one takes a raw string from
// action.yml inputs (or env) and returns either a normalized value, a
// detection result, or throws with a user-actionable message.
//
// Split out of resolve-setup.ts so the orchestration module stays
// focused on cache-key derivation and side-effecting work.

import type { CompileCacheStatsMode, StatsMode } from "./types.js";

/**
 * Parse the `cache-shutdown-on-idle` input into a seconds count.
 *
 * Accepts:
 *   - "" / "0" / "off" / "false" / "no" → null (disabled)
 *   - bare integer ("30")               → that many seconds
 *   - "<N>s" / "<N>m" / "<N>h"          → seconds / minutes / hours
 *
 * Throws on any other value so misspellings ("30sec", "thirty") surface
 * loudly at action start rather than silently being treated as "off".
 */
export function parseCacheShutdownOnIdleSeconds(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "0" || value === "off" || value === "false" || value === "no") {
    return null;
  }
  const m = value.match(/^(\d+)\s*(s|m|h)?$/);
  if (!m) {
    throw new Error(
      `invalid 'cache-shutdown-on-idle' input: '${raw}'. ` +
        "Expected <seconds>, <N>s, <N>m, <N>h, or empty/off/false to disable.",
    );
  }
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid 'cache-shutdown-on-idle' input: '${raw}'.`);
  }
  const unit = m[2] ?? "s";
  if (unit === "s") return n;
  if (unit === "m") return n * 60;
  return n * 3600;
}

/**
 * Detect cross-compile env vars the user has already set that soldr's
 * `linker: fast` default would silently overwrite (CARGO_TARGET_<TRIPLE>_LINKER
 * and CARGO_TARGET_<TRIPLE>_RUSTFLAGS). Returns the list of `NAME=value`
 * strings to surface in the deferral log. See issue #108.
 */
export function detectUserLinkerEnv(env: Record<string, string | undefined>): string[] {
  const hits: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || raw === "") continue;
    if (!name.startsWith("CARGO_TARGET_")) continue;
    if (name.endsWith("_LINKER") || name.endsWith("_RUSTFLAGS")) {
      hits.push(`${name}=${raw}`);
    }
  }
  hits.sort();
  return hits;
}

export function normalizeStatsMode(raw: string): StatsMode {
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "summarize" || v === "detailed") return v;
  return "summarize";
}

export function normalizeCompileCacheStats(raw: string): CompileCacheStatsMode {
  const v = raw.trim().toLowerCase();
  if (v === "none") return "none";
  if (v === "detailed" || v === "insights") return "detailed";
  return "summarize";
}
