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
import { spawnSync } from "node:child_process";
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

// #387 Feature 1: cache-encrypt-key IS a secret even though its name
// matches NEVER_REDACT_PATTERN's `_key$`. core.setSecret() in resolve-setup
// already marks the value for runtime log redaction by the Actions runner,
// but the diagnostics dump has its own writer — belt-and-suspenders here.
const FORCE_REDACT_PATTERN = /(encrypt[-_]?key|cache[-_]encrypt[-_]key|cipher[-_]key|aes[-_]key)/i;

export function redactValue(key: string, value: string): string {
  if (FORCE_REDACT_PATTERN.test(key)) return value ? "<redacted>" : "";
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
    // #387 Feature 1: parsed RawInputs needs the same redaction as raw env —
    // otherwise `cacheEncryptKey` lands here verbatim.
    const safe = typeof v === "string" ? redactValue(k, v) : v;
    lines.push(`  ${k}=${JSON.stringify(safe)}`);
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
  // setup-soldr#102: sibling basenames bundled into the same archive.
  const extras = result.cargoRegistryCache.extraBasenames;
  lines.push(`    extra_basenames=${extras.length > 0 ? extras.join(",") : "(none)"}`);
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
        `key=${o.key}${o.status ? ` status=${o.status}` : ""} duration_ms=${o.durationMs}`,
    );
    if (o.archiveBytes !== null) {
      lines.push(`    archive_bytes=${o.archiveBytes} inflated_bytes=${o.inflatedBytes ?? "?"} files=${o.fileCount ?? "?"}`);
    }
    if (o.payload) {
      lines.push(
        `    payload_bytes=${o.payload.bytes} payload_files=${o.payload.files} ` +
          `symlinks=${o.payload.symlinks} dirs=${o.payload.directories}`,
      );
      if (o.payload.topFiles.length > 0) {
        lines.push(
          `    top_files=${o.payload.topFiles.map((entry) => `${entry.path}:${entry.bytes}`).join(",")}`,
        );
      }
      if (o.payload.skipped.length > 0) {
        lines.push(
          `    skipped=${o.payload.skipped.map((entry) => `${entry.reason}:${entry.count}`).join(",")}`,
        );
      }
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
   * When true, after the summarized `[compile_journal]` section, the
   * dump also emits a `[compile_journal_raw]` section containing the
   * verbatim JSONL contents of `journalPath` (one line per record,
   * indented for log readability). Gated by callers on `debug: true`
   * because the raw stream is large (one record per rustc invocation,
   * typically hundreds per build).
   */
  journalPrintRaw?: boolean;
  /**
   * Verbatim `report` field returned by `soldr cache report --json`
   * (parsed into `SoldrCacheReportSummary.report`). When present, the
   * post-phase dump also includes the `rollups` (per-extension /
   * per-crate) breakdown from `zccache analyze --json`.
   */
  cacheReport?: Record<string, unknown>;
  /**
   * Pre-captured process snapshot from `captureProcessSnapshot()`. When
   * provided, the dump appends a `[processes]` section with verbatim
   * `ps` / `tasklist` output. Used to diagnose orphan zccache-daemon
   * processes that survive `soldr cache shutdown` and get SIGKILL'd by
   * the runner's job cleanup. Captured on the caller side (post.ts) so
   * dumpDiagnostics stays pure for tests.
   */
  processSnapshot?: ProcessSnapshot;
  logger: Logger;
  /** When set, also append the dump to this file as a fenced markdown block. */
  stepSummaryPath?: string;
}

export interface ProcessSnapshot {
  /** The command line used to produce the snapshot (for log clarity). */
  cmd: string;
  /** Verbatim stdout from the listing command. */
  stdout: string;
  /** Any stderr captured; usually empty. Printed when non-empty. */
  stderr: string;
  /** Exit code from the snapshot command. 0 = success. */
  exitCode: number | null;
}

/**
 * Capture a runtime process snapshot via `ps` (Unix) or `tasklist`
 * (Windows). Returns null only on an actual exec failure (binary
 * missing, etc.); a non-zero exit is reported in the result so the
 * stderr can be inspected.
 *
 * Why this lives here: the post step uses it to expose orphan daemons
 * (e.g. zccache-daemon processes that survive `soldr cache shutdown`
 * and get SIGKILL'd by the runner) so root-cause analysis doesn't
 * require another build.
 */
export function captureProcessSnapshot(): ProcessSnapshot | null {
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "tasklist" : "ps";
  // Unix: print pid, ppid, user, state, command-name, full-args.
  // BSD ps (macOS) supports the same -o keys but uses `command` instead
  // of `args` — accept both via the column listing.
  const args = isWindows
    ? ["/V", "/FO", "CSV", "/NH"]
    : ["-eo", "pid,ppid,user,stat,comm,args"];
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
    });
    return {
      cmd: `${cmd} ${args.join(" ")}`,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status,
    };
  } catch {
    return null;
  }
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

    // Raw JSONL dump — verbatim file contents under the summary. Only
    // emitted when the caller opts in (debug=true) because it's huge
    // (one record per rustc invocation, frequently MBs of output).
    if (opts.journalPrintRaw) {
      try {
        const raw = fs.readFileSync(opts.journalPath, "utf8");
        const rawLines = raw.split(/\r?\n/).filter((l) => l.length > 0);
        lines.push(`[compile_journal_raw: verbatim JSONL from ${opts.journalPath} — ${rawLines.length} records]`);
        for (const rawLine of rawLines) {
          lines.push(`  ${rawLine}`);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Already noted by the summary section above; no need to repeat.
        } else {
          lines.push(`[compile_journal_raw]`);
          lines.push(
            `  (failed to read ${opts.journalPath}: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
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

  // Process snapshot — captured by the caller via captureProcessSnapshot()
  // when debug mode is on. Useful for spotting orphan daemons (e.g.
  // zccache-daemon survivors after `soldr cache shutdown`) that the runner
  // SIGKILLs at job cleanup.
  if (opts.processSnapshot) {
    const snap = opts.processSnapshot;
    lines.push(`[processes: snapshot via \`${snap.cmd}\` exit=${snap.exitCode ?? "null"}]`);
    if (snap.stderr.trim().length > 0) {
      lines.push(`  stderr: ${snap.stderr.trim().replace(/\n+/g, " | ")}`);
    }
    const trimmed = snap.stdout.replace(/\r\n/g, "\n").trimEnd();
    if (trimmed.length === 0) {
      lines.push("  (no stdout)");
    } else {
      for (const line of trimmed.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
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
