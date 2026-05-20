// Read + summarize zccache's per-rustc-invocation JSONL journal so
// `dumpDiagnostics` can emit a `[compile_journal]` section telling
// the reader (or future-me) *what* was cached and *why* every miss
// missed. Without this, "warm reports hits=0 misses=206" is true but
// useless — we can't tell whether the cache lookups all returned
// "no cache file with this key" (genuinely-new fingerprint) or "the
// cached entry's recorded inputs don't match my current inputs"
// (content/path/env drift between cold and warm). The journal records
// the per-invocation `outcome` and `miss_reason`; soldr's
// `cache report --json` already returns `zccache analyze --json`'s
// rollups under `report.rollups`. We just have to parse them.
//
// Pure-functional: no `core.*` here, no side effects beyond reading
// the journal file. Easier to unit-test that way.

import * as fs from "node:fs";
import { redactValue } from "./diagnostics.js";

/**
 * One JSONL record produced by zccache for each rustc invocation
 * (cold or warm). Defined by `crates/zccache-daemon/src/compile_journal.rs`.
 * We treat every field as optional so an unknown / future field shape
 * doesn't break parsing — we only assert on the few we actually format.
 */
export interface JournalRecord {
  ts?: string;
  outcome?: string; // "hit" | "miss" | "error" | "link_hit" | "link_miss"
  compiler?: string;
  crate_name?: string;
  crate_type?: string;
  output_ext?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  exit_code?: number;
  session_id?: string;
  latency_ns?: number;
  /** NoCacheFile | CacheCorrupt | PreviousFailure | ContentChanged */
  miss_reason?: string;
  /** Free-form evidence bag — which files/flags/deps caused the miss. */
  miss_diff?: Record<string, unknown>;
  self_profile_ns?: Record<string, number>;
  [key: string]: unknown;
}

export interface SlowestMiss {
  crate: string;
  reason: string;
  ext: string;
  latency_ms: number;
  diff: unknown;
}

export interface JournalSummary {
  total: number;
  /** outcome counts; e.g. `{hit: 12, miss: 200}` */
  outcomes: Record<string, number>;
  /** miss_reason counts; e.g. `{ContentChanged: 198, NoCacheFile: 2}` */
  miss_reasons: Record<string, number>;
  /** per output_ext (best signal of "what kind of artifact"). */
  per_extension: Record<string, { hit: number; miss: number }>;
  /** Top N slowest misses (descending by latency_ns). */
  slowest_misses: SlowestMiss[];
  /** Up to one verbatim record per distinct miss_reason, for inspection. */
  sample_records: JournalRecord[];
}

const SLOWEST_TOP_N = 20;

/**
 * Read a `last-session.jsonl` file. Returns `null` if it doesn't exist
 * (the common "no build happened" case); throws nothing for malformed
 * lines — they're silently skipped so a single garbled record doesn't
 * blank the whole dump.
 */
export function readJournal(path: string): JournalRecord[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const out: JournalRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const obj = JSON.parse(line) as JournalRecord;
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

/**
 * Pure summary. Stable across runs given the same input order so the
 * dump diffs cleanly across CI runs.
 */
export function summarize(records: readonly JournalRecord[]): JournalSummary {
  const outcomes: Record<string, number> = {};
  const miss_reasons: Record<string, number> = {};
  const per_extension: Record<string, { hit: number; miss: number }> = {};
  const misses: JournalRecord[] = [];

  for (const r of records) {
    const outcome = r.outcome ?? "unknown";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (outcome === "miss") {
      const reason = r.miss_reason ?? "unknown";
      miss_reasons[reason] = (miss_reasons[reason] ?? 0) + 1;
      misses.push(r);
    }
    const ext = r.output_ext ?? "?";
    if (!per_extension[ext]) per_extension[ext] = { hit: 0, miss: 0 };
    if (outcome === "hit" || outcome === "link_hit") per_extension[ext].hit += 1;
    else if (outcome === "miss" || outcome === "link_miss") per_extension[ext].miss += 1;
  }

  // Sort misses by latency descending and take top N.
  const slowest_misses: SlowestMiss[] = [...misses]
    .sort((a, b) => (b.latency_ns ?? 0) - (a.latency_ns ?? 0))
    .slice(0, SLOWEST_TOP_N)
    .map((r) => ({
      crate: r.crate_name ?? "?",
      reason: r.miss_reason ?? "?",
      ext: r.output_ext ?? "?",
      latency_ms: Math.round((r.latency_ns ?? 0) / 1_000_000),
      diff: r.miss_diff ?? null,
    }));

  // One sample per distinct miss_reason (covers the long-tail rarer
  // reasons even when ContentChanged dominates the histogram).
  const seenReasons = new Set<string>();
  const sample_records: JournalRecord[] = [];
  for (const r of misses) {
    const reason = r.miss_reason ?? "unknown";
    if (seenReasons.has(reason)) continue;
    seenReasons.add(reason);
    sample_records.push(r);
    if (sample_records.length >= 5) break;
  }
  // Also include one hit sample if we have any, so cold/warm diffs are
  // diffable in both directions.
  const firstHit = records.find((r) => r.outcome === "hit" || r.outcome === "link_hit");
  if (firstHit && sample_records.length < 6) sample_records.push(firstHit);

  return {
    total: records.length,
    outcomes,
    miss_reasons,
    per_extension,
    slowest_misses,
    sample_records,
  };
}

// ---------- formatters ----------

function pad(left: number, right: number, label: string, value: string | number): string {
  return `${label.padEnd(left)}${String(value).padStart(right)}`;
}

function redactEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = redactValue(k, v);
  return out;
}

function formatRecord(r: JournalRecord): string {
  // Hand-shape JSON to keep one record-per-line readable: top-level keys
  // on one line, then args/env/miss_diff (if present) on their own.
  const summary = {
    outcome: r.outcome,
    miss_reason: r.miss_reason,
    crate_name: r.crate_name,
    crate_type: r.crate_type,
    output_ext: r.output_ext,
    latency_ms: r.latency_ns !== undefined ? Math.round(r.latency_ns / 1_000_000) : undefined,
    cwd: r.cwd,
  };
  const parts: string[] = [];
  parts.push(`    summary: ${JSON.stringify(summary)}`);
  if (r.args && r.args.length > 0) {
    parts.push(`    args: ${JSON.stringify(r.args)}`);
  }
  if (r.env && Object.keys(r.env).length > 0) {
    parts.push(`    env (redacted): ${JSON.stringify(redactEnv(r.env))}`);
  }
  if (r.miss_diff && Object.keys(r.miss_diff).length > 0) {
    parts.push(`    miss_diff: ${JSON.stringify(r.miss_diff)}`);
  }
  if (r.self_profile_ns) {
    parts.push(`    self_profile_ns: ${JSON.stringify(r.self_profile_ns)}`);
  }
  return parts.join("\n");
}

/**
 * Format a `[compile_journal]` section's body lines (without the
 * surrounding header/footer — those are added by `dumpDiagnostics`).
 */
export function formatJournalSection(summary: JournalSummary): string[] {
  const lines: string[] = [];
  lines.push(`[compile_journal]`);
  lines.push(`  total_records=${summary.total}`);

  lines.push(`  outcomes:`);
  const outcomeEntries = Object.entries(summary.outcomes).sort((a, b) => b[1] - a[1]);
  if (outcomeEntries.length === 0) lines.push(`    (none)`);
  for (const [k, v] of outcomeEntries) lines.push(`    ${pad(16, 8, k, v)}`);

  lines.push(`  miss_reasons (zccache fingerprint divergence; the answer to "why warm missed"):`);
  const missEntries = Object.entries(summary.miss_reasons).sort((a, b) => b[1] - a[1]);
  if (missEntries.length === 0) lines.push(`    (none)`);
  for (const [k, v] of missEntries) lines.push(`    ${pad(28, 8, k, v)}`);

  lines.push(`  per_output_ext (hit/miss split per artifact kind):`);
  const extEntries = Object.entries(summary.per_extension).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  if (extEntries.length === 0) lines.push(`    (none)`);
  for (const [ext, c] of extEntries) {
    lines.push(`    ${ext.padEnd(10)}hit=${String(c.hit).padStart(5)}  miss=${String(c.miss).padStart(5)}`);
  }

  lines.push(`  slowest_misses (top ${summary.slowest_misses.length} by wall-clock):`);
  if (summary.slowest_misses.length === 0) lines.push(`    (none)`);
  for (const m of summary.slowest_misses) {
    lines.push(
      `    ${String(m.latency_ms + "ms").padStart(7)}  ${m.reason.padEnd(20)}  ${m.ext.padEnd(8)}  ${m.crate}`,
    );
    if (m.diff && typeof m.diff === "object" && Object.keys(m.diff as object).length > 0) {
      lines.push(`        diff: ${JSON.stringify(m.diff)}`);
    }
  }

  lines.push(`  sample_records (one verbatim per distinct outcome, env redacted):`);
  if (summary.sample_records.length === 0) lines.push(`    (none)`);
  for (let i = 0; i < summary.sample_records.length; i += 1) {
    lines.push(`  --- record ${i + 1} ---`);
    lines.push(formatRecord(summary.sample_records[i]!));
  }

  return lines;
}

/**
 * Format the `rollups` field returned by `soldr cache report --json`
 * (i.e. `zccache analyze --json` output). Tolerates missing /
 * malformed fields — older soldr versions or error paths just yield
 * an empty section.
 */
export function formatRollupsSection(
  report: Record<string, unknown> | undefined | null,
): string[] {
  const lines: string[] = [];
  lines.push(`[compile_rollups (zccache analyze --json)]`);
  if (!report || typeof report !== "object") {
    lines.push(`  (no report payload)`);
    return lines;
  }
  const rollups = (report as { rollups?: unknown }).rollups;
  if (!rollups || typeof rollups !== "object") {
    lines.push(`  (no rollups field)`);
    return lines;
  }
  const r = rollups as Record<string, unknown>;

  // by_extension: { ext: { hits, misses, total_ns } }
  const byExt = r.by_extension as Record<string, { hits?: number; misses?: number; total_ns?: number }> | undefined;
  lines.push(`  by_extension:`);
  if (!byExt || Object.keys(byExt).length === 0) lines.push(`    (none)`);
  else {
    for (const [ext, v] of Object.entries(byExt)) {
      const hits = v?.hits ?? 0;
      const misses = v?.misses ?? 0;
      const totalMs = Math.round((v?.total_ns ?? 0) / 1_000_000);
      const denom = hits + misses;
      const rate = denom > 0 ? ((hits / denom) * 100).toFixed(1) : "n/a";
      lines.push(
        `    ${ext.padEnd(10)}hits=${String(hits).padStart(5)}  misses=${String(misses).padStart(5)}  rate=${rate.padStart(5)}%  total=${totalMs}ms`,
      );
    }
  }

  // slowest_entries: [{outcome, crate_name, latency_ns}, ...]
  const slowest = r.slowest_entries as Array<Record<string, unknown>> | undefined;
  lines.push(`  slowest_entries (analyze top-N):`);
  if (!slowest || slowest.length === 0) lines.push(`    (none)`);
  else {
    for (const e of slowest.slice(0, 20)) {
      const latencyMs = Math.round(Number(e.latency_ns ?? 0) / 1_000_000);
      const outcome = String(e.outcome ?? "?");
      const crate = String(e.crate_name ?? "?");
      lines.push(`    ${String(latencyMs + "ms").padStart(7)}  ${outcome.padEnd(10)}  ${crate}`);
    }
  }

  // miss_crate_counts: { crate: N }
  const missByCrate = r.miss_crate_counts as Record<string, number> | undefined;
  lines.push(`  miss_crate_counts (top 20):`);
  if (!missByCrate || Object.keys(missByCrate).length === 0) lines.push(`    (none)`);
  else {
    const sorted = Object.entries(missByCrate)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 20);
    for (const [crate, count] of sorted) {
      lines.push(`    ${String(count).padStart(5)}  ${crate}`);
    }
  }

  return lines;
}
