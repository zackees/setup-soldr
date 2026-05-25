// setup-soldr#98 PR3 — insights-mode renderer + GitHub annotation builder.
// setup-soldr#98 PR4 — multi-step session aggregator + roll-up renderer.
//
// PR3 surface (insights):
//   - `renderInsights(payload)` consumes the `diagnoses[]` array shipped by
//     `soldr cache report --json` (schema defined in zackees/soldr#321) and
//     produces a Markdown block (per-diagnosis <details> with severity emoji,
//     headline, evidence tables, suggested_fix blockquote) plus a list of
//     GitHub workflow-command annotations (::warning::/::notice:: with
//     optional file= pins) ready to forward to core.warning / core.notice.
//
// PR4 surface (multi-step aggregation):
//   - `collectArchivedSessionStats(archiveDir)` walks
//     `<cache-dir>/logs/archive/<session-id>/last-session-stats.json`
//     (the soldr#379 `--archive-logs` layout) and returns one parsed JSON
//     object per session.
//   - `aggregateSessions(statsFiles)` rolls every per-session payload up
//     into a single `MultiSessionRollup` (totals + weighted hit rate +
//     per-session breakdown).
//   - `renderMultiSessionRollup(rollup)` emits a collapsed <details>
//     block titled "Multi-step roll-up (N sessions)" with the aggregate
//     scalars at the top and a per-session table beneath. Renders the
//     empty string when sessionCount <= 1 so the existing single-session
//     surface stays the single source of truth on jobs that only run one
//     cargo command.
//
// All renderers are pure — no I/O, no @actions/* imports — so they stay
// trivially unit-testable. The post-step wires their output into the
// step-summary append + the @actions/core annotation surface.

import * as fs from "node:fs";
import * as path from "node:path";

interface MissReason {
  category?: string;
  file?: string;
  flag?: string;
  misses?: number;
}

interface SlowestMiss {
  crate?: string;
  ms?: number;
  miss_reason?: string;
}

interface DiagnosisEvidence {
  miss_reasons_top?: MissReason[];
  slowest_misses?: SlowestMiss[];
  wasted_ms?: number;
}

interface Diagnosis {
  severity?: string;
  headline?: string;
  evidence?: DiagnosisEvidence;
  suggested_fix?: string;
}

export interface InsightsRenderResult {
  /**
   * Markdown to append to $GITHUB_STEP_SUMMARY. Empty string when there
   * are no diagnoses — the caller can append unconditionally.
   */
  markdown: string;
  /**
   * GitHub workflow-command annotation lines (e.g.
   * `::warning file=path,line=1::<headline>`). The caller forwards each
   * one to `core.warning`/`core.notice` so it shows up pinned to the
   * relevant file in the PR UI. Empty array when there are no diagnoses.
   */
  annotations: string[];
}

/** Markdown table cell escaping — keeps the table grid intact. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Severity → leading emoji. Maps "high" to a red circle (loudest signal in
 * a step summary), "medium" to yellow, "low" to green. Unknown severities
 * fall back to the medium glyph so the renderer never throws on a typo
 * from a future soldr release.
 */
function severityEmoji(severity: string | undefined): string {
  switch ((severity ?? "").toLowerCase()) {
    case "high":
      return "🔴";
    case "medium":
      return "🟡";
    case "low":
      return "🟢";
    default:
      return "🟡";
  }
}

/**
 * Severity → GitHub workflow-command verb. "high" gets `::warning::` so it
 * surfaces in the PR Files-Changed view; "medium"/"low" get `::notice::`
 * (less intrusive — annotation-tray only). Unknown severities default to
 * notice, the more conservative choice.
 */
function severityCommand(severity: string | undefined): "warning" | "notice" {
  return (severity ?? "").toLowerCase() === "high" ? "warning" : "notice";
}

/** Human-readable ms → seconds when ≥ 1s, otherwise verbatim ms. */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms} ms`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms} ms`;
}

/**
 * Strip newlines from a string before splicing it into a GitHub workflow
 * command. The `::warning ::<msg>` syntax breaks if `<msg>` contains a
 * literal `\n` (the runner stops parsing at the line break). URL-encoded
 * `%0A` is the documented escape; the actions/core library uses the same
 * transform internally.
 */
function escapeAnnotationMessage(msg: string): string {
  return msg.replace(/\r?\n/g, "%0A").replace(/\r/g, "%0D");
}

/**
 * Pull the first miss-reason entry that has a file path. Used to pin the
 * workflow annotation to a specific source file when one is available.
 * Falls back to undefined when no entry carries a file (e.g. all misses
 * are flag-driven).
 */
function pickFile(evidence: DiagnosisEvidence | undefined): string | undefined {
  const top = evidence?.miss_reasons_top;
  if (!Array.isArray(top)) return undefined;
  for (const entry of top) {
    if (entry && typeof entry.file === "string" && entry.file.length > 0) {
      return entry.file;
    }
  }
  return undefined;
}

function renderMissReasonsTable(rows: MissReason[]): string[] {
  if (rows.length === 0) return [];
  const out: string[] = [];
  out.push("| Category | File/Flag | Misses |");
  out.push("| --- | --- | --- |");
  for (const row of rows) {
    const category = typeof row.category === "string" ? row.category : "";
    const fileOrFlag =
      typeof row.file === "string" && row.file.length > 0
        ? row.file
        : typeof row.flag === "string"
          ? row.flag
          : "";
    const misses =
      typeof row.misses === "number" && Number.isFinite(row.misses)
        ? String(row.misses)
        : "";
    out.push(`| ${cell(category)} | ${cell(fileOrFlag)} | ${misses} |`);
  }
  return out;
}

function renderSlowestMissesList(rows: SlowestMiss[]): string[] {
  if (rows.length === 0) return [];
  const out: string[] = ["", "**Slowest misses:**", ""];
  for (const row of rows) {
    const crateName = typeof row.crate === "string" ? row.crate : "(unknown)";
    const ms = typeof row.ms === "number" ? row.ms : 0;
    const reason = typeof row.miss_reason === "string" ? row.miss_reason : "";
    const reasonText = reason ? ` — ${reason}` : "";
    out.push(`- ${crateName}: ${fmtMs(ms)} (${ms} ms)${reasonText}`);
  }
  return out;
}

function renderOneDiagnosis(diag: Diagnosis): string[] {
  const emoji = severityEmoji(diag.severity);
  const headline = typeof diag.headline === "string" ? diag.headline : "(no headline)";
  const lines: string[] = [];
  lines.push("<details>");
  lines.push(`<summary>${emoji} ${headline}</summary>`);
  lines.push("");
  const evidence = diag.evidence;
  const missRows = Array.isArray(evidence?.miss_reasons_top)
    ? (evidence!.miss_reasons_top as MissReason[])
    : [];
  if (missRows.length > 0) {
    lines.push("**Top miss reasons:**", "");
    lines.push(...renderMissReasonsTable(missRows));
  }
  const slowest = Array.isArray(evidence?.slowest_misses)
    ? (evidence!.slowest_misses as SlowestMiss[])
    : [];
  if (slowest.length > 0) {
    lines.push(...renderSlowestMissesList(slowest));
  }
  if (evidence && typeof evidence.wasted_ms === "number" && Number.isFinite(evidence.wasted_ms)) {
    lines.push("", `**Wasted compile time:** ${fmtMs(evidence.wasted_ms)}`);
  }
  if (typeof diag.suggested_fix === "string" && diag.suggested_fix.length > 0) {
    lines.push("");
    // Render the suggested fix as a Markdown blockquote so it stands
    // out from the evidence body — the user's eye goes straight to the
    // "what do I do about this" line.
    lines.push(`> ${diag.suggested_fix}`);
  }
  lines.push("");
  lines.push("</details>");
  return lines;
}

function buildAnnotation(diag: Diagnosis): string {
  const verb = severityCommand(diag.severity);
  const file = pickFile(diag.evidence);
  const headline = typeof diag.headline === "string" ? diag.headline : "(no headline)";
  const message = escapeAnnotationMessage(headline);
  if (file) {
    return `::${verb} file=${file},line=1::${message}`;
  }
  return `::${verb}::${message}`;
}

/**
 * Render the insights surface from a parsed `soldr cache report --json`
 * payload. Tolerant of every optional field — a payload from an older
 * soldr (no `diagnoses` array) returns an empty result without throwing.
 */
export function renderInsights(payload: Record<string, unknown>): InsightsRenderResult {
  const raw = payload?.["diagnoses"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { markdown: "", annotations: [] };
  }
  const diagnoses = raw as Diagnosis[];
  const markdownChunks: string[] = [];
  const annotations: string[] = [];
  for (const diag of diagnoses) {
    markdownChunks.push(...renderOneDiagnosis(diag));
    annotations.push(buildAnnotation(diag));
  }
  return {
    markdown: markdownChunks.join("\n"),
    annotations,
  };
}

// ---------------------------------------------------------------------------
// PR4 — Multi-step session aggregation.
// ---------------------------------------------------------------------------

/**
 * Per-session row inside a multi-step roll-up. Mirrors the four scalars a
 * downstream consumer most often wants to surface (session id, hits,
 * misses, hit rate, wall-clock saved). `hitRate` is null when the session
 * payload didn't carry one (very old soldr, or zero compilations).
 */
export interface MultiSessionRow {
  sessionId: string;
  hits: number;
  misses: number;
  hitRate: number | null;
  timeSavedMs: number;
}

/**
 * Roll-up over every per-invocation `last-session-stats.json` archived
 * under `<cache-dir>/logs/archive/<session-id>/`. `overallHitRate` is
 * weighted across compilations (NOT the unweighted mean of per-session
 * rates) so a job that runs `cargo build` + `cargo test` reports a hit
 * rate that reflects actual cache effectiveness across the whole job.
 * `null` when no compilations happened across any session — never NaN.
 */
export interface MultiSessionRollup {
  sessionCount: number;
  totalHits: number;
  totalMisses: number;
  totalCompilations: number;
  overallHitRate: number | null;
  totalTimeSavedMs: number;
  totalBytesRead: number;
  totalBytesWritten: number;
  sessions: MultiSessionRow[];
}

/** Number coercion that tolerates undefined / non-finite values. */
function numField(stats: Record<string, unknown>, key: string): number | undefined {
  const value = stats[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strField(stats: Record<string, unknown>, key: string): string | undefined {
  const value = stats[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Walk `<archiveDir>/<session-id>/last-session-stats.json` and return one
 * parsed JSON object per session. Missing dir → empty array (most common
 * case — first run of a job, no archive present yet). Invalid JSON
 * entries are silently skipped so one corrupt file doesn't poison the
 * whole roll-up. Non-object payloads are also skipped.
 */
export function collectArchivedSessionStats(archiveDir: string): Array<Record<string, unknown>> {
  if (!archiveDir) return [];
  let entries: fs.Dirent[];
  try {
    const stat = fs.statSync(archiveDir);
    if (!stat.isDirectory()) return [];
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const statsPath = path.join(archiveDir, ent.name, "last-session-stats.json");
    let raw: string;
    try {
      raw = fs.readFileSync(statsPath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const stats = parsed as Record<string, unknown>;
    // Default the session_id to the on-disk dir name if the JSON itself
    // didn't carry one — gives the per-session table something to render
    // even when older soldr versions skipped writing the field.
    if (typeof stats["session_id"] !== "string") {
      stats["session_id"] = ent.name;
    }
    out.push(stats);
  }
  return out;
}

/**
 * Roll a list of per-session `last-session-stats.json` payloads up into
 * one aggregate. Entries with `status` != "ok" (e.g. "missing", "invalid")
 * are skipped — they carry no compilation counters worth summing.
 */
export function aggregateSessions(
  statsFiles: Array<Record<string, unknown>>,
): MultiSessionRollup {
  let totalHits = 0;
  let totalMisses = 0;
  let totalCompilations = 0;
  let totalTimeSavedMs = 0;
  let totalBytesRead = 0;
  let totalBytesWritten = 0;
  const sessions: MultiSessionRow[] = [];
  for (const raw of statsFiles) {
    if (!raw || typeof raw !== "object") continue;
    const status = strField(raw, "status");
    // Treat a missing `status` as "ok" so callers that hand us a bare
    // last_session payload (no envelope status field) still aggregate.
    if (status !== undefined && status !== "ok") continue;
    const hits = numField(raw, "hits") ?? 0;
    const misses = numField(raw, "misses") ?? 0;
    const compilations = numField(raw, "compilations") ?? hits + misses;
    const timeSavedMs = numField(raw, "time_saved_ms") ?? 0;
    const bytesRead = numField(raw, "bytes_read") ?? 0;
    const bytesWritten = numField(raw, "bytes_written") ?? 0;
    const hitRate = numField(raw, "hit_rate") ?? null;
    const sessionId = strField(raw, "session_id") ?? `session-${sessions.length + 1}`;
    totalHits += hits;
    totalMisses += misses;
    totalCompilations += compilations;
    totalTimeSavedMs += timeSavedMs;
    totalBytesRead += bytesRead;
    totalBytesWritten += bytesWritten;
    sessions.push({ sessionId, hits, misses, hitRate, timeSavedMs });
  }
  const overallHitRate = totalCompilations > 0 ? totalHits / totalCompilations : null;
  return {
    sessionCount: sessions.length,
    totalHits,
    totalMisses,
    totalCompilations,
    overallHitRate,
    totalTimeSavedMs,
    totalBytesRead,
    totalBytesWritten,
    sessions,
  };
}

/** ms → "12.4s" / "850 ms" — matches the existing PR1 single-session table. */
function fmtMsRollup(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms} ms`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms} ms`;
}

/** bytes → "412.0 MB" etc — same scale as post.ts's fmtBytes. */
function fmtBytesRollup(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`;
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Percentage formatter with the trailing "%". Null/undefined → "n/a". */
function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Cell-escape pipes and newlines to keep the Markdown table grid intact. */
function rollupCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Render the multi-step roll-up as a Markdown `<details>` block titled
 * "Multi-step roll-up (N sessions)". Aggregate scalars table sits at the
 * top, per-session table below. Returns the empty string when the job
 * only saw one session (or none) — the existing single-session renderer
 * already covers that case and a roll-up would be redundant noise.
 */
export function renderMultiSessionRollup(rollup: MultiSessionRollup): string {
  if (rollup.sessionCount <= 1) return "";
  const lines: string[] = [];
  lines.push("<details>");
  lines.push(`<summary>Multi-step roll-up (${rollup.sessionCount} sessions)</summary>`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Sessions | ${rollup.sessionCount} |`);
  lines.push(`| Total compilations | ${rollup.totalCompilations} |`);
  lines.push(`| Total hits | ${rollup.totalHits} |`);
  lines.push(`| Total misses | ${rollup.totalMisses} |`);
  lines.push(`| Overall hit rate | ${fmtPct(rollup.overallHitRate)} |`);
  if (rollup.totalTimeSavedMs > 0) {
    lines.push(`| Time saved (est.) | ${fmtMsRollup(rollup.totalTimeSavedMs)} |`);
  }
  if (rollup.totalBytesRead > 0) {
    lines.push(`| Bytes read | ${fmtBytesRollup(rollup.totalBytesRead)} |`);
  }
  if (rollup.totalBytesWritten > 0) {
    lines.push(`| Bytes written | ${fmtBytesRollup(rollup.totalBytesWritten)} |`);
  }
  lines.push("");
  lines.push("| Session | Hits | Misses | Hit rate | Time saved |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of rollup.sessions) {
    lines.push(
      `| ${rollupCell(row.sessionId)} | ${row.hits} | ${row.misses} | ${fmtPct(
        row.hitRate,
      )} | ${fmtMsRollup(row.timeSavedMs)} |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}
