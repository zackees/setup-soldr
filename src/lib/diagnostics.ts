// Verbose diagnostic dump emitted when the action receives `logging: true`.
//
// The goal is to make cache-behavior surprises trivially debuggable from a
// single CI run. The dump bundles:
//   - every observed INPUT_* env var (so the kebab-vs-underscore plumbing
//     bug that motivated this module is visible without re-running)
//   - the parsed RawInputs struct
//   - every constructed cache key with restore-key fallbacks
//   - resolved env exports (SOLDR_*, ZCCACHE_*, SETUP_SOLDR_*)
//   - cache restore/save outcomes recorded so far
//   - the final cache summary + compile-cache report in post phase
//
// Token-shaped values are redacted before printing.

import * as fs from "node:fs";
import {
  formatJournalSection,
  formatRollupsSection,
  readJournal,
  summarize as summarizeJournal,
} from "./compile-journal.js";
import type { CacheOpStats, Logger, RawInputs, ResolveResult } from "./types.js";

const ENV_KEY_PREFIXES: readonly string[] = [
  "INPUT_",
  "SOLDR_",
  "ZCCACHE_",
  "SCCACHE_",
  "SETUP_SOLDR_",
  "GITHUB_",
  "RUNNER_",
  "ACTION_",
  "CARGO_",
  "RUSTUP_",
  "RUSTC_",
];

const SECRET_KEY_PATTERN = /(token|secret|password|^.*_pass$|api[_-]?key|client[_-]?secret|webhook)/i;

// Cache-key fields look secret-y but never are; never redact them.
const NEVER_REDACT_PATTERN = /(_key$|cache[-_]key|cache[-_]keys$|key[-_]suffix$|public[-_]key)/i;

export function redactValue(key: string, value: string): string {
  if (NEVER_REDACT_PATTERN.test(key)) return value;
  if (SECRET_KEY_PATTERN.test(key)) return value ? "<redacted>" : "";
  return value;
}

function pickEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!ENV_KEY_PREFIXES.some((p) => k.startsWith(p))) continue;
    pairs.push([k, redactValue(k, v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs;
}

function rawInputsLines(inputs: RawInputs): string[] {
  const lines: string[] = [];
  const entries = Object.entries(inputs).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [k, v] of entries) {
    lines.push(`  ${k}=${JSON.stringify(v)}`);
  }
  return lines;
}

function cachePlanLines(result: ResolveResult): string[] {
  const lines: string[] = [];
  lines.push("  setup_cache:");
  lines.push(`    key=${result.setupCache.key}`);
  lines.push(`    restore_prefix=${result.setupCache.restorePrefix}`);
  lines.push(`    paths=${JSON.stringify(result.setupCache.paths)}`);
  lines.push(`    layout=${result.setupCache.layout}`);
  lines.push("  build_cache:");
  lines.push(`    key=${result.buildCache.key}`);
  lines.push(`    restore_key_parent=${result.buildCache.restoreKeyParent || "(none)"}`);
  lines.push(`    restore_key_toolchain=${result.buildCache.restoreKeyToolchain}`);
  lines.push(`    restore_key_os_arch=${result.buildCache.restoreKeyOsArch}`);
  lines.push(`    path=${result.buildCache.path}`);
  lines.push(`    mode=${result.buildCache.mode}`);
  lines.push("  target_cache:");
  lines.push(`    enabled=${result.targetCache.enabled}`);
  lines.push(`    key=${result.targetCache.key}`);
  lines.push(`    restore_key_parent=${result.targetCache.restoreKeyParent || "(none)"}`);
  lines.push(`    restore_key_lock=${result.targetCache.restoreKeyLock || "(none)"}`);
  lines.push(`    restore_key_lockfile=${result.targetCache.restoreKeyLockfile || "(none)"}`);
  lines.push(`    paths=${result.targetCache.paths}`);
  lines.push(`    bundle_path=${result.targetCache.bundlePath}`);
  lines.push(`    target_path=${result.targetCache.targetPath}`);
  lines.push(`    effective_mode=${result.targetCache.effectiveMode}`);
  lines.push(`    profile=${result.targetCache.profile}`);
  lines.push("  cargo_registry_cache:");
  lines.push(`    enabled=${result.cargoRegistryCache.enabled}`);
  lines.push(`    key=${result.cargoRegistryCache.key}`);
  lines.push(`    restore_prefix=${result.cargoRegistryCache.restorePrefix}`);
  lines.push(`    path=${result.cargoRegistryCache.path}`);
  return lines;
}

function envExportLines(result: ResolveResult): string[] {
  const entries = Object.entries(result.envExports).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return entries.map(([k, v]) => `  ${k}=${redactValue(k, v)}`);
}

function cacheOutcomeLines(outcomes: readonly CacheOpStats[]): string[] {
  if (outcomes.length === 0) return ["  (no outcomes recorded yet)"];
  const lines: string[] = [];
  for (const o of outcomes) {
    lines.push(
      `  [${o.operation}] ${o.label}: hit=${o.hit} matched=${o.matchedKey || "(none)"} ` +
        `key=${o.key} duration_ms=${o.durationMs}`,
    );
    if (o.archiveBytes !== null) {
      lines.push(`    archive_bytes=${o.archiveBytes} inflated_bytes=${o.inflatedBytes ?? "?"} files=${o.fileCount ?? "?"}`);
    }
  }
  return lines;
}

export interface DumpOptions {
  phase: "main" | "post";
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  rawInputs?: RawInputs;
  result?: ResolveResult;
  cacheOutcomes?: readonly CacheOpStats[];
  /** Verbatim FinalCacheSummary from post.ts. Stringified as pretty JSON. */
  finalSummary?: Record<string, unknown>;
  /**
   * Path to zccache's per-rustc-invocation JSONL journal (typically
   * `${ZCCACHE_CACHE_DIR}/logs/last-session.jsonl`). When set AND the
   * file exists, the post-phase dump appends a `[compile_journal]`
   * section with per-outcome / per-miss-reason histograms + a sample
   * of verbatim records so the reader can answer "why didn't warm hit?"
   * from this one log block.
   */
  journalPath?: string;
  /**
   * Verbatim `report` field returned by `soldr cache report --json`
   * (parsed into `SoldrCacheReportSummary.report`). When present, the
   * post-phase dump also includes the `rollups` (per-extension /
   * per-crate) breakdown from `zccache analyze --json`.
   */
  cacheReport?: Record<string, unknown>;
  logger: Logger;
  /** When set, also append the dump to this file as a fenced markdown block. */
  stepSummaryPath?: string;
}

/**
 * Emit the full diagnostic dump to the logger and (optionally) the step summary.
 * Safe to call when `result`, `cacheOutcomes`, or `finalSummary` are missing —
 * each section is independent.
 */
export function dumpDiagnostics(opts: DumpOptions): void {
  const lines: string[] = [];
  const header = `=== DIAGNOSTIC DUMP (phase=${opts.phase}) ===`;
  const footer = "=== END DIAGNOSTIC DUMP ===";

  lines.push(header);

  lines.push("[env: observed INPUT_/SOLDR_/ZCCACHE_/SETUP_SOLDR_/GITHUB_/RUNNER_/ACTION_/CARGO_/RUSTUP_/RUSTC_]");
  const envPairs = pickEnv(opts.env);
  if (envPairs.length === 0) {
    lines.push("  (none observed)");
  } else {
    for (const [k, v] of envPairs) {
      lines.push(`  ${k}=${v}`);
    }
  }

  if (opts.rawInputs) {
    lines.push("[raw_inputs: parsed RawInputs after kebab-case lookup]");
    lines.push(...rawInputsLines(opts.rawInputs));
  }

  if (opts.result) {
    lines.push("[cache_plans: every constructed cache key + restore-key fallbacks]");
    lines.push(...cachePlanLines(opts.result));
    lines.push("[env_exports: resolved SOLDR_/ZCCACHE_/etc env exports]");
    if (Object.keys(opts.result.envExports).length === 0) {
      lines.push("  (none)");
    } else {
      lines.push(...envExportLines(opts.result));
    }
    lines.push("[resolved_state]");
    lines.push(`  enabled=${opts.result.enabled}`);
    lines.push(`  workspace=${opts.result.workspace}`);
    lines.push(`  cache_root=${opts.result.cacheRoot}`);
    lines.push(`  soldr_root=${opts.result.soldrRoot}`);
    lines.push(`  cargo_home=${opts.result.cargoHome}`);
    lines.push(`  rustup_home=${opts.result.rustupHome}`);
    lines.push(`  soldr_path=${opts.result.soldrPath}`);
    lines.push(`  soldr_repo=${opts.result.soldrRepo}`);
    lines.push(`  soldr_ref=${opts.result.soldrRef || "(release)"}`);
    lines.push(`  soldr_version_requested=${opts.result.soldrVersionRequested}`);
    lines.push(`  soldr_version_resolved=${opts.result.soldrVersionResolved}`);
    lines.push(`  toolchain_channel=${opts.result.toolchain.channel}`);
    lines.push(`  toolchain_cache_channel=${opts.result.toolchain.cacheChannel}`);
    lines.push(`  rustup_strategy=${opts.result.rustupStrategy}`);
    lines.push(`  shims_enabled=${opts.result.shimsEnabled}`);
    lines.push(`  shims_dir=${opts.result.shimsDir}`);
    lines.push(`  stats=${opts.result.stats}`);
    lines.push(`  compile_cache_stats=${opts.result.compileCacheStats}`);
    lines.push(`  debug_mode=${opts.result.debugMode}`);
    lines.push(`  cache_shutdown_on_idle_seconds=${opts.result.cacheShutdownOnIdleSeconds ?? "(unset)"}`);
  }

  if (opts.cacheOutcomes !== undefined) {
    lines.push("[cache_outcomes: per-layer restore/save results]");
    lines.push(...cacheOutcomeLines(opts.cacheOutcomes));
  }

  if (opts.finalSummary) {
    lines.push("[final_cache_summary]");
    const json = JSON.stringify(opts.finalSummary, null, 2);
    for (const line of json.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  // Per-compilation zccache journal — the answer to "warm reports
  // hits=0; WHY did each lookup miss?". Reads the JSONL emitted by
  // zccache for the just-finished session, summarizes it (outcome +
  // miss_reason histograms, slowest misses with their miss_diff, a
  // handful of verbatim records), and prints. Silently no-ops when
  // the journal file isn't present.
  if (opts.journalPath) {
    try {
      const records = readJournal(opts.journalPath);
      if (records === null) {
        lines.push(`[compile_journal]`);
        lines.push(`  (journal file not found at ${opts.journalPath})`);
      } else if (records.length === 0) {
        lines.push(`[compile_journal]`);
        lines.push(`  (journal file empty at ${opts.journalPath})`);
      } else {
        lines.push(...formatJournalSection(summarizeJournal(records)));
      }
    } catch (err) {
      lines.push(`[compile_journal]`);
      lines.push(
        `  (failed to read ${opts.journalPath}: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // Rollups (per-extension / per-crate) from `soldr cache report --json`.
  // The raw report is already parsed into finalSummary's
  // compile_cache_report.report; we accept it as a separate
  // `cacheReport` so callers can pass it without rebuilding the
  // FinalCacheSummary shape.
  if (opts.cacheReport) {
    lines.push(...formatRollupsSection(opts.cacheReport));
  }

  lines.push(footer);

  for (const line of lines) {
    opts.logger.log(line);
  }

  if (opts.stepSummaryPath) {
    appendToStepSummary(opts.stepSummaryPath, opts.phase, lines, opts.logger);
  }
}

function appendToStepSummary(
  summaryPath: string,
  phase: "main" | "post",
  lines: readonly string[],
  logger: Logger,
): void {
  const block: string[] = [
    `### setup-soldr diagnostic dump (phase=${phase})`,
    "",
    "```",
    ...lines,
    "```",
    "",
  ];
  try {
    fs.appendFileSync(summaryPath, block.join("\n") + "\n", "utf8");
  } catch (err) {
    logger.log(`diagnostics: failed to append to step summary: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Truthy check matching the rest of the action: "1", "true", "yes", "on".
 * Empty / unset / anything else is false.
 */
export function loggingEnabled(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
