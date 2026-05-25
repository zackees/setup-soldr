// setup-soldr#98 PR3 — insights-mode renderer + GitHub annotation builder.
//
// Consumes the `diagnoses[]` array shipped by `soldr cache report --json`
// (schema defined in zackees/soldr#321) and produces:
//
//   - A Markdown block (per-diagnosis <details> with severity emoji,
//     headline, evidence tables, and a suggested_fix blockquote) suitable
//     for appending to $GITHUB_STEP_SUMMARY.
//   - A list of GitHub workflow-command annotations
//     (::warning::/::notice:: with optional file= pins) ready to be
//     forwarded to core.warning / core.notice in the post-step runner.
//
// The renderer is pure — no I/O, no @actions/* imports — so it stays
// trivially unit-testable. The post-step wires its output into the
// step-summary append + the @actions/core annotation surface.

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
