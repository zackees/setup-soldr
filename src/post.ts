// setup-soldr post-job entry point. Owned by Agent 2.
//
// Runs in the post-job phase via action.yml's `post: dist/post.js`. This is
// the architectural fix for zackees/setup-soldr#70 — it lets us tar+zstd
// the build-cache (and optionally cargo-registry) directories BEFORE
// @actions/cache's post-save uploads them, so the wire format is zstd on
// every platform (including Windows-x64 where actions/cache@v5 still
// falls back to gzip).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as core from "@actions/core";
import * as cache from "@actions/cache";
import { compressCache } from "./lib/cache-compress.js";
import { saveSoloCache, stageDiffForSave, type RootMap as SoloRootMap } from "./lib/solo-toolchain-cache.js";
import type { SnapshotDiff } from "./lib/toolchain-snapshot.js";
import { saveCookCache } from "./lib/cook-cache.js";
import { saveMiniCache } from "./lib/soldr-mini-cache.js";
import { createLogger } from "./lib/log-utils.js";
import { shutdownCacheDaemons } from "./lib/shutdown-cache.js";
import { StatsCollector } from "./lib/stats-collector.js";
import { captureProcessSnapshot, dumpDiagnostics, loggingEnabled } from "./lib/diagnostics.js";
import { readRawInputs } from "./lib/raw-inputs.js";
import {
  snapshotSourceMtimes,
  writeSnapshotFile,
  SNAPSHOT_FILENAME,
} from "./lib/source-mtime-snapshot.js";
import type { CompileCacheStatsMode, ResolveResult, StatsMode } from "./lib/types.js";

type RestoreStatus = "disabled" | "exact-hit" | "restore-key-hit" | "miss";
type SaveStatus = "disabled" | "not-managed-in-post" | "exact-hit-skip" | "missing-dir-skip" | "saved" | "failed";

interface CacheSaveResult {
  status: SaveStatus;
  cache_dir?: string;
  archive_path?: string;
  saved_paths?: string[];
  cache_id?: number;
  error?: string;
}

interface CacheLayerSummary {
  enabled: boolean;
  key: string;
  matched_key: string;
  exact_hit: boolean;
  restore_status: RestoreStatus;
  save: CacheSaveResult;
}

interface ZccacheSessionSummary {
  stats_path: string;
  present: boolean;
  status: string;
  stats?: Record<string, unknown>;
  error?: string;
}

/**
 * Output of `soldr cache report --json`. Always present in the post-step
 * payload even when the soldr binary is missing or returns an error - the
 * `status` field tells consumers which fields are populated.
 *
 * Status values:
 *  - "ok": `report` is set; soldr returned a parseable envelope.
 *  - "missing-binary": SOLDR_BINARY env var was not set or pointed at a
 *    nonexistent path. Older setup-soldr versions or shimming oddities.
 *  - "unsupported": the installed soldr does not have the `cache report`
 *    subcommand (i.e. < 0.7.22). The `error` field carries soldr's exit
 *    line so callers can tell user vs version-skew failures apart.
 *  - "error": soldr exited non-zero or returned unparseable JSON.
 */
interface SoldrCacheReportSummary {
  status: "ok" | "missing-binary" | "unsupported" | "error";
  soldr_version?: string;
  managed_zccache_version?: string;
  error?: string;
  /** Verbatim copy of `soldr cache report --json` stdout, parsed. */
  report?: Record<string, unknown>;
}

export interface FinalCacheSummary {
  schema_version: 1;
  setup_cache: CacheLayerSummary;
  target_cache: CacheLayerSummary;
  build_cache: CacheLayerSummary;
  cargo_registry_cache: CacheLayerSummary;
  zccache_session: ZccacheSessionSummary;
  /** Added in setup-soldr#98. Populated by post-step from `soldr cache report --json`. */
  compile_cache_report: SoldrCacheReportSummary;
}

interface RestoreState {
  setupCacheEnabled: boolean;
  setupCacheExactHit: boolean;
  setupCacheMatchedKey: string;
  targetCacheEnabled: boolean;
  targetCacheExactHit: boolean;
  targetCacheMatchedKey: string;
  buildCacheEnabled: boolean;
  buildCacheExactHit: boolean;
  buildCacheMatchedKey: string;
  cargoRegistryCacheEnabled: boolean;
  cargoRegistryCacheExactHit: boolean;
  cargoRegistryCacheMatchedKey: string;
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function stateBool(name: string, fallback = false): boolean {
  const value = core.getState(name).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/**
 * Decide whether the post-phase diagnostic dump includes the verbatim
 * per-rustc-invocation JSONL stream. The raw stream is large (thousands
 * of records / 20-30 MB on the demo warm build) and dominates Post Setup
 * Soldr wall-clock when emitted. Default: mirror debug mode (preserves
 * pre-existing behavior for workflows that already opted into debug).
 * Explicit values "true"/"false"/"on"/"off"/"yes"/"no"/"1"/"0" override.
 */
export function resolveJournalPrintRaw(rawValue: string, debugMode: boolean): boolean {
  const v = (rawValue ?? "").trim().toLowerCase();
  if (v === "") return debugMode;
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return debugMode;
}

function readRestoreState(): RestoreState {
  return {
    setupCacheEnabled: stateBool("setupCacheEnabled"),
    setupCacheExactHit: stateBool("setupCacheExactHit"),
    setupCacheMatchedKey: core.getState("setupCacheMatchedKey"),
    targetCacheEnabled: stateBool("targetCacheEnabled"),
    targetCacheExactHit: stateBool("targetCacheExactHit"),
    targetCacheMatchedKey: core.getState("targetCacheMatchedKey"),
    buildCacheEnabled: stateBool("buildCacheEnabled"),
    buildCacheExactHit: stateBool("buildCacheExactHit"),
    buildCacheMatchedKey: core.getState("buildCacheMatchedKey"),
    cargoRegistryCacheEnabled: stateBool("cargoRegistryCacheEnabled"),
    cargoRegistryCacheExactHit: stateBool("cargoRegistryCacheExactHit"),
    cargoRegistryCacheMatchedKey: core.getState("cargoRegistryCacheMatchedKey"),
  };
}

function disabledSave(): CacheSaveResult {
  return { status: "disabled" };
}

// setup-cache is intentionally restore-only. Its restore is kept so the
// action's `cache-hit` output (wired from setupCacheExactHit in main.ts)
// retains its public contract for downstream workflows, but the save path
// is permanently inert: the soldr binary moved to soldr-mini-cache (#142)
// and the rustup toolchain state moved to solo-toolchain-cache (#139),
// both of which are content-addressable and coarser-keyed. Wiring a save
// here would re-introduce a duplicate path and defeat those layers' LRU
// access pattern. See setup-soldr#151 for the full decision rationale.
function notManagedSave(): CacheSaveResult {
  return { status: "not-managed-in-post" };
}

function restoreStatus(enabled: boolean, exactHit: boolean, matchedKey: string): RestoreStatus {
  if (!enabled) return "disabled";
  if (exactHit) return "exact-hit";
  if (matchedKey.trim()) return "restore-key-hit";
  return "miss";
}

async function saveOne(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
  key: string;
  matchedKey: string;
  label: string;
  debug: boolean;
  log: (msg: string) => void;
  /**
   * Optional sibling basenames bundled into the same archive as `cacheDir`.
   * Used by the cargo-registry layer to ship `.global-cache` and `git/` next
   * to `registry/` without a new cache layer — setup-soldr#102.
   */
  extraBasenames?: string[];
}): Promise<CacheSaveResult & { archiveBytes: number | null }> {
  const { cacheDir, codec, level, key, matchedKey, label, debug, log, extraBasenames } = opts;
  const withBytes = (r: CacheSaveResult): CacheSaveResult & { archiveBytes: number | null } =>
    Object.assign(r, { archiveBytes: null });
  if (!dirExists(cacheDir)) {
    log(`${label}: cache dir ${cacheDir} does not exist, skipping save`);
    return withBytes({ status: "missing-dir-skip", cache_dir: cacheDir });
  }
  if (matchedKey === key) {
    log(`${label}: exact cache hit on ${key}, skipping save`);
    return withBytes({ status: "exact-hit-skip", cache_dir: cacheDir });
  }
  let archiveBytes: number | null = null;
  let archivePath: string | null = null;
  try {
    const result = await compressCache({ cacheDir, codec, level, debug, log, extraBasenames });
    archivePath = result.archivePath;
    archiveBytes = result.archiveBytes || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${label}: compression failed: ${message}`);
    return withBytes({ status: "failed", cache_dir: cacheDir, error: message });
  }
  const pathsToSave = archivePath ? [archivePath] : [cacheDir];
  try {
    const id = await cache.saveCache(pathsToSave, key);
    log(`${label}: saved cache id=${id} key=${key} via ${archivePath ? "tar.zst" : "default"}`);
    return {
      status: "saved",
      cache_dir: cacheDir,
      archive_path: archivePath ?? undefined,
      saved_paths: pathsToSave,
      cache_id: id,
      archiveBytes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${label}: save failed: ${message}`);
    return {
      status: "failed",
      cache_dir: cacheDir,
      archive_path: archivePath ?? undefined,
      saved_paths: pathsToSave,
      error: message,
      archiveBytes,
    };
  }
}

function cacheLayerSummary(opts: {
  enabled: boolean;
  key: string;
  exactHit: boolean;
  matchedKey: string;
  save: CacheSaveResult;
}): CacheLayerSummary {
  const matchedKey = opts.matchedKey.trim();
  return {
    enabled: opts.enabled,
    key: opts.key,
    matched_key: matchedKey,
    exact_hit: opts.enabled ? opts.exactHit : false,
    restore_status: restoreStatus(opts.enabled, opts.exactHit, matchedKey),
    save: opts.save,
  };
}

function readSoldrCacheReport(
  soldrBinary: string | undefined,
  passthrough: boolean,
): SoldrCacheReportSummary {
  if (passthrough) {
    // Short-circuit when the main step installed a passthrough stub
    // (enable=false). Skips spawning a .cmd on Windows (where
    // child_process.spawnSync can't launch shell scripts directly) and
    // documents the passthrough state in the post-step summary.
    return {
      status: "ok",
      soldr_version: "passthrough",
      report: {
        notes: ["setup-soldr enable=false: soldr passthrough stub"],
        last_session: null,
        rollups: null,
      },
    };
  }
  if (!soldrBinary || !fileExists(soldrBinary)) {
    return {
      status: "missing-binary",
      error:
        soldrBinary === undefined
          ? "SOLDR_BINARY env var not set"
          : `soldr binary at ${soldrBinary} does not exist`,
    };
  }
  // Use spawnSync so the post step has no async dependencies. The
  // report subcommand is fast (sub-100ms) — never worth pulling in
  // @actions/exec just for one shell-out.
  const child = spawnSync(soldrBinary, ["cache", "report", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.error) {
    return {
      status: "error",
      error: `failed to spawn soldr: ${child.error.message}`,
    };
  }
  const stdout = (child.stdout || "").trim();
  const stderr = (child.stderr || "").trim();
  if (child.status !== 0) {
    const combined = `${stderr}\n${stdout}`;
    if (
      /unrecognized subcommand|invalid value for|unknown sub[- ]?command/i.test(combined) &&
      /\breport\b/.test(combined)
    ) {
      return {
        status: "unsupported",
        error: stderr || stdout || `soldr exited ${child.status}`,
      };
    }
    return {
      status: "error",
      error: stderr || stdout || `soldr exited ${child.status}`,
    };
  }
  let report: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "error",
        error: "soldr cache report --json returned a non-object payload",
      };
    }
    report = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      status: "error",
      error: `failed to parse soldr cache report JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const soldrVersion = typeof report["soldr_version"] === "string" ? (report["soldr_version"] as string) : undefined;
  const zccacheVersion =
    typeof report["managed_zccache_version"] === "string"
      ? (report["managed_zccache_version"] as string)
      : undefined;
  return {
    status: "ok",
    soldr_version: soldrVersion,
    managed_zccache_version: zccacheVersion,
    report,
  };
}

function readZccacheSessionSummary(buildCachePath: string): ZccacheSessionSummary {
  const statsPath = path.join(buildCachePath, "logs", "last-session-stats.json");
  if (!fileExists(statsPath)) {
    return { stats_path: statsPath, present: false, status: "missing" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        stats_path: statsPath,
        present: true,
        status: "invalid",
        error: "stats JSON was not an object",
      };
    }
    const stats = parsed as Record<string, unknown>;
    const status = typeof stats["status"] === "string" ? stats["status"] : "unknown";
    return { stats_path: statsPath, present: true, status, stats };
  } catch (err) {
    return {
      stats_path: statsPath,
      present: true,
      status: "invalid",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildFinalCacheSummary(
  result: ResolveResult,
  state: RestoreState,
  saves: {
    buildCache: CacheSaveResult;
    cargoRegistryCache: CacheSaveResult;
    targetCache: CacheSaveResult;
  },
  passthrough = false,
): FinalCacheSummary {
  return {
    schema_version: 1,
    setup_cache: cacheLayerSummary({
      enabled: state.setupCacheEnabled,
      key: result.setupCache.key,
      exactHit: state.setupCacheExactHit,
      matchedKey: state.setupCacheMatchedKey,
      save: notManagedSave(),
    }),
    target_cache: cacheLayerSummary({
      enabled: state.targetCacheEnabled,
      key: result.targetCache.key,
      exactHit: state.targetCacheExactHit,
      matchedKey: state.targetCacheMatchedKey,
      save: saves.targetCache,
    }),
    build_cache: cacheLayerSummary({
      enabled: state.buildCacheEnabled,
      key: result.buildCache.key,
      exactHit: state.buildCacheExactHit,
      matchedKey: state.buildCacheMatchedKey,
      save: saves.buildCache,
    }),
    cargo_registry_cache: cacheLayerSummary({
      enabled: state.cargoRegistryCacheEnabled,
      key: result.cargoRegistryCache.key,
      exactHit: state.cargoRegistryCacheExactHit,
      matchedKey: state.cargoRegistryCacheMatchedKey,
      save: saves.cargoRegistryCache,
    }),
    zccache_session: readZccacheSessionSummary(result.buildCache.path),
    compile_cache_report: readSoldrCacheReport(process.env["SOLDR_BINARY"]?.trim(), passthrough),
  };
}

function numberStat(stats: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = stats?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function zccacheOneLine(summary: ZccacheSessionSummary): string {
  if (!summary.present) return `missing (${summary.stats_path})`;
  if (summary.status !== "ok") {
    return summary.error ? `${summary.status} (${summary.error})` : summary.status;
  }
  const hits = numberStat(summary.stats, "hits") ?? 0;
  const misses = numberStat(summary.stats, "misses") ?? 0;
  const compilations = numberStat(summary.stats, "compilations") ?? hits + misses;
  const nonCacheable = numberStat(summary.stats, "non_cacheable") ?? 0;
  const errors = numberStat(summary.stats, "errors") ?? 0;
  const hitRate = numberStat(summary.stats, "hit_rate");
  const hitRateText = hitRate === undefined ? "n/a" : `${(hitRate * 100).toFixed(1)}%`;
  return `hits=${hits} misses=${misses} compilations=${compilations} non_cacheable=${nonCacheable} errors=${errors} hit_rate=${hitRateText}`;
}

function restoreText(layer: CacheLayerSummary): string {
  if (!layer.enabled) return "disabled";
  if (layer.restore_status === "exact-hit") return "exact hit";
  if (layer.restore_status === "restore-key-hit") return "restore-key hit";
  return "miss";
}

function saveText(save: CacheSaveResult): string {
  switch (save.status) {
    case "saved":
      return save.cache_id === undefined ? "saved" : `saved id=${save.cache_id}`;
    case "exact-hit-skip":
      return "skipped exact hit";
    case "missing-dir-skip":
      return "skipped missing dir";
    case "failed":
      return save.error ? `failed: ${save.error}` : "failed";
    case "disabled":
      return "disabled";
    case "not-managed-in-post":
      return "not managed in post";
  }
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tableRow(label: string, layer: CacheLayerSummary): string {
  return [
    label,
    restoreText(layer),
    layer.key,
    layer.matched_key || "",
    saveText(layer.save),
  ]
    .map(markdownCell)
    .join(" | ");
}

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

function setCompileCacheOutputs(report: SoldrCacheReportSummary, mode: CompileCacheStatsMode): void {
  core.setOutput("compile-cache-session-status", report.status);
  if (report.status !== "ok" || !report.report) return;
  core.setOutput("compile-cache-summary-json", JSON.stringify(report.report));
  const lastSession = report.report["last_session"] as Record<string, unknown> | null;
  if (lastSession) {
    const hits = numberStat(lastSession, "hits") ?? 0;
    const misses = numberStat(lastSession, "misses") ?? 0;
    const compilations = numberStat(lastSession, "compilations") ?? hits + misses;
    const hitRate = numberStat(lastSession, "hit_rate");
    const timeSavedMs = numberStat(lastSession, "time_saved_ms");
    const bytesRead = numberStat(lastSession, "bytes_read");
    const bytesWritten = numberStat(lastSession, "bytes_written");
    core.setOutput("compile-cache-hits", String(hits));
    core.setOutput("compile-cache-misses", String(misses));
    core.setOutput("compile-cache-compilations", String(compilations));
    if (hitRate !== undefined) core.setOutput("compile-cache-hit-rate", String(hitRate));
    if (timeSavedMs !== undefined) core.setOutput("compile-cache-time-saved-ms", String(timeSavedMs));
    if (bytesRead !== undefined) core.setOutput("compile-cache-bytes-read", String(bytesRead));
    if (bytesWritten !== undefined) core.setOutput("compile-cache-bytes-written", String(bytesWritten));
  }
  if (mode === "detailed") {
    const rollups = report.report["rollups"];
    if (rollups) core.setOutput("compile-cache-rollups-json", JSON.stringify(rollups));
  }
}

function compileCacheReportSection(report: SoldrCacheReportSummary, mode: CompileCacheStatsMode): string[] {
  if (mode === "none") return [];
  const lines: string[] = ["", "### Compile cache (zccache)", ""];
  if (report.status !== "ok" || !report.report) {
    lines.push(`| Status | ${markdownCell(report.status)} |`);
    if (report.error) lines.push(`| Detail | ${markdownCell(report.error)} |`);
    return lines;
  }
  const body = report.report;
  const lastSession = (body["last_session"] as Record<string, unknown> | null) ?? null;
  const rollups = (body["rollups"] as Record<string, unknown> | null) ?? null;
  if (lastSession) {
    const hits = numberStat(lastSession, "hits") ?? 0;
    const misses = numberStat(lastSession, "misses") ?? 0;
    const compilations = numberStat(lastSession, "compilations") ?? hits + misses;
    const rate = numberStat(lastSession, "hit_rate");
    const rateText = rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;
    const saved = numberStat(lastSession, "time_saved_ms");
    const bytesRead = numberStat(lastSession, "bytes_read");
    const bytesWritten = numberStat(lastSession, "bytes_written");
    lines.push("| Metric | Value |", "| --- | --- |");
    lines.push(`| Compilations | ${compilations} |`);
    lines.push(`| Hits | ${hits} |`);
    lines.push(`| Misses | ${misses} |`);
    lines.push(`| Hit rate | ${rateText} |`);
    if (saved !== undefined) lines.push(`| Time saved (est.) | ${(saved / 1000).toFixed(1)}s |`);
    if (bytesRead !== undefined) lines.push(`| Bytes read | ${fmtBytes(bytesRead)} |`);
    if (bytesWritten !== undefined) lines.push(`| Bytes written | ${fmtBytes(bytesWritten)} |`);
    if (report.soldr_version) lines.push(`| soldr | ${markdownCell(report.soldr_version)} |`);
    if (report.managed_zccache_version) lines.push(`| zccache | ${markdownCell(report.managed_zccache_version)} |`);
  } else {
    lines.push("_(no last\\_session yet — run a cache-enabled build first)_");
  }
  if (mode === "detailed" && rollups) {
    const byExt = rollups["by_extension"];
    if (byExt && typeof byExt === "object" && !Array.isArray(byExt)) {
      const rows = Object.entries(byExt as Record<string, unknown>);
      if (rows.length > 0) {
        lines.push("", "#### By output extension", "");
        lines.push("| Extension | Hits | Misses | Total ms |", "| --- | --- | --- | --- |");
        for (const [ext, bucket] of rows) {
          const b = (bucket as Record<string, unknown>) ?? {};
          const h = numberStat(b, "hits") ?? 0;
          const m = numberStat(b, "misses") ?? 0;
          const t = numberStat(b, "total_ms") ?? 0;
          lines.push(`| ${markdownCell(ext)} | ${h} | ${m} | ${t} |`);
        }
      }
    }
    const byTool = rollups["by_tool_total_ms"];
    if (byTool && typeof byTool === "object" && !Array.isArray(byTool)) {
      const rows = Object.entries(byTool as Record<string, unknown>)
        .map(([tool, ms]) => [tool, typeof ms === "number" ? ms : 0] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      if (rows.length > 0) {
        lines.push("", "#### By tool (wall-clock)", "");
        lines.push("| Tool | ms |", "| --- | --- |");
        for (const [tool, ms] of rows) {
          lines.push(`| ${markdownCell(tool)} | ${ms} |`);
        }
      }
    }
  }
  const notes = body["notes"];
  if (Array.isArray(notes) && notes.length > 0) {
    lines.push("", "<details><summary>Notes from soldr</summary>", "");
    for (const note of notes) {
      if (typeof note === "string") lines.push(`- ${markdownCell(note)}`);
    }
    lines.push("", "</details>");
  }
  return lines;
}

export function formatFinalCacheSummaryMarkdown(
  summary: FinalCacheSummary,
  compileCacheStats: CompileCacheStatsMode = "summarize",
): string {
  const lines = [
    "## setup-soldr final cache summary",
    "",
    "| Layer | Restore | Primary key | Matched key | Save |",
    "| --- | --- | --- | --- | --- |",
    `| ${tableRow("setup cache", summary.setup_cache)} |`,
    `| ${tableRow("target cache", summary.target_cache)} |`,
    `| ${tableRow("build cache", summary.build_cache)} |`,
    `| ${tableRow("cargo registry cache", summary.cargo_registry_cache)} |`,
    "",
    "### zccache session",
    "",
    `- Stats: ${zccacheOneLine(summary.zccache_session)}`,
    `- Stats file: ${summary.zccache_session.stats_path}`,
    ...compileCacheReportSection(summary.compile_cache_report, compileCacheStats),
    "",
    "<details><summary>Final cache summary JSON</summary>",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "</details>",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function logFinalCacheSummary(summary: FinalCacheSummary, log: (msg: string) => void): void {
  log(
    `final cache summary: setup=${restoreText(summary.setup_cache)} target=${restoreText(summary.target_cache)} ` +
      `build=${restoreText(summary.build_cache)}/${saveText(summary.build_cache.save)} ` +
      `cargo-registry=${restoreText(summary.cargo_registry_cache)}/${saveText(summary.cargo_registry_cache.save)}`,
  );
  log(`final zccache session stats: ${zccacheOneLine(summary.zccache_session)}`);
  log(`compile cache report: ${compileCacheReportOneLine(summary.compile_cache_report)}`);
}

function compileCacheReportOneLine(report: SoldrCacheReportSummary): string {
  if (report.status !== "ok" || !report.report) {
    return report.error ? `${report.status} (${report.error})` : report.status;
  }
  const lastSession = report.report["last_session"] as Record<string, unknown> | null;
  if (!lastSession) {
    return `ok (no last_session yet, soldr ${report.soldr_version ?? "?"})`;
  }
  const hits = numberStat(lastSession, "hits") ?? 0;
  const misses = numberStat(lastSession, "misses") ?? 0;
  const rate = numberStat(lastSession, "hit_rate");
  const rateText = rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;
  return `ok hits=${hits} misses=${misses} hit_rate=${rateText} soldr=${report.soldr_version ?? "?"}`;
}

function writeCompileCacheReportFile(
  report: SoldrCacheReportSummary,
  runnerTemp: string,
  log: (msg: string) => void,
): string | undefined {
  if (!runnerTemp) return undefined;
  const outPath = path.join(runnerTemp, "setup-soldr-compile-cache-report.json");
  try {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    return outPath;
  } catch (err) {
    log(`post: failed to write compile-cache-report.json: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function writeStepSummary(markdown: string, log: (msg: string) => void): void {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"]?.trim();
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, markdown, "utf8");
  } catch (err) {
    log(`post: failed to write GitHub step summary: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function run(): Promise<void> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);
  const state = core.getState("resolveResult");
  if (!state) {
    log("post: no resolve state available, exiting");
    return;
  }
  let result: ResolveResult;
  try {
    result = JSON.parse(state) as ResolveResult;
  } catch (err) {
    log(`post: failed to parse resolve state: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const buildCacheMatched = core.getState("buildCacheMatchedKey");
  const registryMatched = core.getState("cargoRegistryCacheMatchedKey");
  const passthrough = stateBool("setupSoldrPassthrough");
  const restoreState = readRestoreState();
  const statsMode = (core.getState("statsMode") || "summarize") as StatsMode;
  const compileCacheStats = (core.getState("compileCacheStats") || "summarize") as CompileCacheStatsMode;
  const runnerTemp = core.getState("runnerTemp") || "";
  const debugMode = result.debugMode ?? false;
  const debugLog = debugMode ? log : (): void => undefined;
  const postCollector = new StatsCollector();

  // Always stop long-running cache daemons before packing the build
  // cache so file locks release and the tarball reflects a quiescent
  // on-disk view. Best-effort; failures are logged, not raised.
  //
  // Wire `--archive-logs <build-cache>/logs/archive` through so soldr
  // (post-#379) stashes the just-ended session's logs into a
  // per-session subdirectory inside the build-cache. Setup-soldr's
  // existing tar.zst flow already picks up the entire build-cache
  // subtree, so the archived logs ride the cache cycle for free and
  // survive across runs (see issue #126).
  const logsArchiveDir = restoreState.buildCacheEnabled
    ? path.join(result.buildCache.path, "logs", "archive")
    : undefined;
  await shutdownCacheDaemons({
    soldrPath: process.env["SOLDR_BINARY"]?.trim() || undefined,
    logsArchiveDir,
    log,
  });

  // Source-mtime snapshot (preserve-source-mtimes opt-in). Walk tracked
  // sources, capture each (mtime, size, content-hash), and drop the JSON
  // INSIDE the build-cache directory so it gets bundled into the same
  // tar.zst the build-cache save will upload. main.ts replays the
  // mtimes on warm after the build-cache decompresses, gated on each
  // file's content matching what we snapshotted here.
  const preserveSourceMtimes = core.getState("preserveSourceMtimes") === "true";
  if (preserveSourceMtimes && restoreState.buildCacheEnabled) {
    const t0 = Date.now();
    // The "project root" — where the Cargo workspace being built actually
    // lives — is the parent of the resolved target-dir, NOT result.workspace
    // (which is GITHUB_WORKSPACE — usually the outer checkout containing
    // the action itself plus one or more sub-repos). For the demo,
    // result.workspace=/home/runner/work/setup-soldr/setup-soldr but the
    // zccache project being built is at .../setup-soldr/zccache.
    const projectRoot = path.dirname(result.targetCache.targetPath);
    try {
      const r = await snapshotSourceMtimes({ workspace: projectRoot, log });
      const out = path.join(result.buildCache.path, SNAPSHOT_FILENAME);
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        writeSnapshotFile(r.snapshot, out);
        log(
          `source-mtime-snapshot: wrote ${out} scanned=${r.scanned} hashed=${r.hashed} skipped=${r.skipped} elapsed_ms=${Date.now() - t0}`,
        );
      } catch (err) {
        log(
          `source-mtime-snapshot: failed to write ${out}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      log(
        `source-mtime-snapshot: scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Build cache
  const buildSaveStart = Date.now();
  const buildSave = restoreState.buildCacheEnabled
    ? await saveOne({
        cacheDir: result.buildCache.path,
        codec: result.targetCacheCompress,
        level: result.targetCacheCompressLevel,
        key: result.buildCache.key,
        matchedKey: buildCacheMatched,
        label: "build-cache",
        debug: debugMode,
        log: debugLog,
      })
    : Object.assign(disabledSave(), { archiveBytes: null });
  if (buildSave.status === "saved") {
    postCollector.record({
      label: "build-cache", operation: "save", hit: false,
      key: result.buildCache.key, matchedKey: buildCacheMatched, restoreKeys: [],
      archiveBytes: buildSave.archiveBytes, inflatedBytes: null, fileCount: null,
      durationMs: Date.now() - buildSaveStart, timestamp: new Date().toISOString(),
    });
  }

  // Target cache. Previously slotted as `notManagedSave()` in the
  // finalSummary — i.e. restored in main.ts but never saved here. That
  // meant every commit cold-rebuilt `target/` (or the rust-plan bundle)
  // because no entry was ever written for the restore-key prefix to
  // fall back to. This block fixes the gap.
  //
  // Behavior:
  // - Skip when target-cache layer is disabled (`target-cache: false`
  //   or umbrella `cache: false`).
  // - Skip on exact-hit (re-saving the same content under the same key
  //   wastes time and triggers @actions/cache's "reservation already
  //   exists" path).
  // - Use `cache.saveCache` directly with the multi-path array (one
  //   path in `thin`/`once` modes, two in `full`). @actions/cache will
  //   tar+compress with its default codec — we don't route through
  //   compressCache because target-cache may legitimately carry
  //   multiple roots and compressCache is single-dir-shaped.
  // - Paths array must match the one passed to restoreCache in main.ts
  //   (the @actions/cache "version" hash depends on it — same gotcha
  //   that bit cook-cache in #141).
  let targetCacheSave: CacheSaveResult & { archiveBytes: number | null } = Object.assign(
    disabledSave(),
    { archiveBytes: null as number | null },
  );
  if (restoreState.targetCacheEnabled) {
    const targetPaths = result.targetCache.paths
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const targetKey = result.targetCache.key;
    const targetMatched = restoreState.targetCacheMatchedKey;
    if (targetPaths.length === 0) {
      log("target-cache: no paths configured, skipping save");
      targetCacheSave = Object.assign(
        { status: "missing-dir-skip" as const, cache_dir: "(no paths)" },
        { archiveBytes: null as number | null },
      );
    } else if (restoreState.targetCacheExactHit) {
      log(`target-cache: exact cache hit on ${targetKey}, skipping save`);
      targetCacheSave = Object.assign(
        { status: "exact-hit-skip" as const, cache_dir: targetPaths.join(",") },
        { archiveBytes: null as number | null },
      );
    } else {
      const existingPaths = targetPaths.filter((p) => fs.existsSync(p));
      if (existingPaths.length === 0) {
        log(`target-cache: none of the configured paths exist on disk (${targetPaths.join(", ")}), skipping save`);
        targetCacheSave = Object.assign(
          { status: "missing-dir-skip" as const, cache_dir: targetPaths.join(",") },
          { archiveBytes: null as number | null },
        );
      } else {
        const targetSaveStart = Date.now();
        try {
          const id = await cache.saveCache(existingPaths, targetKey);
          if (id <= 0) {
            log(
              `target-cache: save did not reserve a new entry (id=${id}) — likely a parallel ` +
                `job already saved key=${targetKey}`,
            );
            targetCacheSave = Object.assign(
              {
                status: "failed" as const,
                cache_dir: existingPaths.join(","),
                saved_paths: existingPaths,
                error: `saveCache returned id=${id} (reserve failed; race or quota)`,
              },
              { archiveBytes: null as number | null },
            );
          } else {
            log(`target-cache: saved cache id=${id} key=${targetKey} paths=${existingPaths.join(",")}`);
            targetCacheSave = Object.assign(
              {
                status: "saved" as const,
                cache_dir: existingPaths.join(","),
                saved_paths: existingPaths,
                cache_id: id,
              },
              { archiveBytes: null as number | null },
            );
            postCollector.record({
              label: "target-cache",
              operation: "save",
              hit: false,
              key: targetKey,
              matchedKey: targetMatched,
              restoreKeys: [],
              archiveBytes: null,
              inflatedBytes: null,
              fileCount: null,
              durationMs: Date.now() - targetSaveStart,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`target-cache: save failed: ${message}`);
          targetCacheSave = Object.assign(
            {
              status: "failed" as const,
              cache_dir: existingPaths.join(","),
              saved_paths: existingPaths,
              error: message,
            },
            { archiveBytes: null as number | null },
          );
        }
      }
    }
  }

  // Cargo registry cache (only when enabled).
  // setup-soldr#102: bundle `.global-cache` (cargo's RFC-3413 GC db) and the
  // `git/` directory (bare mirrors + checkouts for git-source crate deps)
  // into the same archive alongside `registry/`. Cache key + archive path
  // are unchanged — the extras simply ride inside the existing tarball.
  let cargoRegistrySave = Object.assign(disabledSave(), { archiveBytes: null as number | null });
  if (result.cargoRegistryCache.enabled) {
    const regSaveStart = Date.now();
    cargoRegistrySave = await saveOne({
      cacheDir: result.cargoRegistryCache.path,
      codec: result.targetCacheCompress,
      level: result.targetCacheCompressLevel,
      key: result.cargoRegistryCache.key,
      matchedKey: registryMatched,
      label: "cargo-registry-cache",
      debug: debugMode,
      log: debugLog,
      extraBasenames: result.cargoRegistryCache.extraBasenames,
    });
    if (cargoRegistrySave.status === "saved") {
      postCollector.record({
        label: "cargo-registry", operation: "save", hit: false,
        key: result.cargoRegistryCache.key, matchedKey: registryMatched, restoreKeys: [],
        archiveBytes: cargoRegistrySave.archiveBytes, inflatedBytes: null, fileCount: null,
        durationMs: Date.now() - regSaveStart, timestamp: new Date().toISOString(),
      });
    }
  }

  // Solo toolchain cache save. Opt-in via the `solo-toolchain-cache`
  // input. Skip the save when the install delta is empty (the common
  // case on hosted runners that already provide the requested
  // toolchain) — per CLAUDE.md "Default-stable workflows should
  // produce zero cache writes."
  const soloEnabled = core.getState("soloToolchainEnabled") === "true";
  if (soloEnabled) {
    const soloExactKey = core.getState("soloToolchainExactKey");
    const soloMatchedKey = core.getState("soloToolchainMatchedKey");
    const soloExactHit = core.getState("soloToolchainExactHit") === "true";
    const soloIncrementalEmpty = core.getState("soloToolchainIncrementalEmpty") === "true";
    const soloSaveDiffPath = core.getState("soloToolchainSaveDiffPath");
    const soloLevel = core.getState("soloToolchainLevel") || "19";
    log(
      `solo-toolchain-cache: post-step exactKey=${soloExactKey} matched=${soloMatchedKey} ` +
        `exactHit=${soloExactHit} incrementalEmpty=${soloIncrementalEmpty} saveDiffPath=${soloSaveDiffPath}`,
    );
    if (soloExactHit && soloIncrementalEmpty) {
      log("solo-toolchain-cache: exact hit and no install delta — skipping save");
    } else if (!soloSaveDiffPath || !fs.existsSync(soloSaveDiffPath)) {
      log("solo-toolchain-cache: no save-diff manifest available, skipping save");
    } else {
      try {
        const manifest = JSON.parse(fs.readFileSync(soloSaveDiffPath, "utf8")) as {
          added?: SnapshotDiff["added"];
        };
        const added = Array.isArray(manifest.added) ? manifest.added : [];
        if (added.length === 0) {
          log("solo-toolchain-cache: empty save-diff manifest, skipping save");
        } else {
          const soloRootMap: SoloRootMap = {
            "rustup-toolchains": path.join(result.rustupHome, "toolchains"),
            "cargo-bin": path.join(result.cargoHome, "bin"),
          };
          const stagingDir = path.join(runnerTemp, "setup-soldr-solo-stage-save");
          const soloSaveStart = Date.now();
          const staged = await stageDiffForSave(
            { added, removed: [], changed: [] },
            soloRootMap,
            stagingDir,
          );
          log(
            `solo-toolchain-cache: staged ${staged.stagedFiles} files (missing=${staged.missingFiles})`,
          );
          const saveResult = await saveSoloCache({
            stagingDir,
            key: soloExactKey,
            level: soloLevel,
            debug: debugMode,
            log,
          });
          if (saveResult.status === "saved") {
            postCollector.record({
              label: "solo-toolchain-cache",
              operation: "save",
              hit: false,
              key: soloExactKey,
              matchedKey: soloMatchedKey,
              restoreKeys: [],
              archiveBytes: saveResult.archiveBytes ?? null,
              inflatedBytes: saveResult.inflatedBytes ?? null,
              fileCount: saveResult.fileCount ?? null,
              durationMs: Date.now() - soloSaveStart,
              timestamp: new Date().toISOString(),
            });
          } else {
            log(`solo-toolchain-cache: save status=${saveResult.status} error=${saveResult.error ?? "none"}`);
          }
        }
      } catch (err) {
        log(
          `solo-toolchain-cache: save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Cook cache save. Default-on layer; skipped when cook didn't run
  // (cache hit, gate disabled, or run failed). zstd-19 + --long=27 per
  // CLAUDE.md "Compression" + the cook simulation findings.
  const cookEnabled = core.getState("cookEnabled") === "true";
  if (cookEnabled) {
    const cookHit = core.getState("cookHit") === "true";
    const cookRan = core.getState("cookRan") === "true";
    const cookExactKey = core.getState("cookExactKey");
    const cookTargetDir = core.getState("cookTargetDir");
    const cookLongWindow = parseInt(core.getState("cookLongWindow") || "27", 10);
    const cookLevel = core.getState("cookCompressLevel") || "19";
    log(
      `cook-cache: post-step key=${cookExactKey} hit=${cookHit} ran=${cookRan} target=${cookTargetDir}`,
    );
    if (cookHit) {
      log("cook-cache: exact hit - skipping save");
    } else if (!cookRan) {
      log("cook-cache: cook did not run successfully - skipping save");
    } else if (!cookTargetDir || !fs.existsSync(cookTargetDir)) {
      log(`cook-cache: target dir ${cookTargetDir} missing - skipping save`);
    } else {
      const cookSaveStart = Date.now();
      try {
        const saveResult = await saveCookCache({
          targetDir: cookTargetDir,
          exactKey: cookExactKey,
          level: cookLevel,
          longWindow: cookLongWindow,
          debug: debugMode,
          log,
        });
        if (saveResult.status === "saved") {
          postCollector.record({
            label: "cook-cache",
            operation: "save",
            hit: false,
            key: cookExactKey,
            matchedKey: "",
            restoreKeys: [],
            archiveBytes: saveResult.archiveBytes ?? null,
            inflatedBytes: saveResult.inflatedBytes ?? null,
            fileCount: saveResult.fileCount ?? null,
            durationMs: Date.now() - cookSaveStart,
            timestamp: new Date().toISOString(),
          });
        } else {
          log(`cook-cache: save status=${saveResult.status} error=${saveResult.error ?? "none"}`);
        }
      } catch (err) {
        log(`cook-cache: save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Soldr-mini-cache save. Default-on; skipped when restore already hit
  // (binary is byte-identical, no point re-saving), when disabled, or
  // when running in passthrough mode.
  const soldrMiniEnabled = core.getState("soldrMiniEnabled") === "true";
  if (soldrMiniEnabled && !passthrough) {
    const miniHit = core.getState("soldrMiniHit") === "true";
    const miniExactKey = core.getState("soldrMiniExactKey");
    const miniInstallDir = core.getState("soldrMiniInstallDir");
    const miniArchive = core.getState("soldrMiniArchive");
    log(
      `soldr-mini-cache: post-step key=${miniExactKey} hit=${miniHit} installDir=${miniInstallDir}`,
    );
    if (miniHit) {
      log("soldr-mini-cache: exact hit — skipping save");
    } else if (!miniExactKey) {
      log("soldr-mini-cache: no key (ineligible at main-time) — skipping save");
    } else if (!miniInstallDir || !fs.existsSync(miniInstallDir)) {
      log(`soldr-mini-cache: install dir ${miniInstallDir} missing — skipping save`);
    } else {
      const miniSaveStart = Date.now();
      try {
        const saveResult = await saveMiniCache({
          installDir: miniInstallDir,
          archivePath: miniArchive,
          exactKey: miniExactKey,
          level: "19",
          longWindow: 27,
          debug: debugMode,
          log,
        });
        if (saveResult.status === "saved") {
          postCollector.record({
            label: "soldr-mini-cache",
            operation: "save",
            hit: false,
            key: miniExactKey,
            matchedKey: "",
            restoreKeys: [],
            archiveBytes: saveResult.archiveBytes ?? null,
            inflatedBytes: saveResult.inflatedBytes ?? null,
            fileCount: saveResult.fileCount ?? null,
            durationMs: Date.now() - miniSaveStart,
            timestamp: new Date().toISOString(),
          });
        } else {
          log(
            `soldr-mini-cache: save status=${saveResult.status} error=${saveResult.error ?? "none"}`,
          );
        }
      } catch (err) {
        log(`soldr-mini-cache: save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const finalSummary = buildFinalCacheSummary(
    result,
    restoreState,
    {
      buildCache: buildSave,
      cargoRegistryCache: cargoRegistrySave,
      targetCache: targetCacheSave,
    },
    passthrough,
  );
  logFinalCacheSummary(finalSummary, log);
  if (compileCacheStats !== "none") {
    setCompileCacheOutputs(finalSummary.compile_cache_report, compileCacheStats);
  }
  writeStepSummary(formatFinalCacheSummaryMarkdown(finalSummary, compileCacheStats), log);
  const reportPath = writeCompileCacheReportFile(finalSummary.compile_cache_report, runnerTemp, log);
  if (reportPath) {
    log(`compile-cache-report.json written to ${reportPath}`);
  }

  // Note: setup-soldr-cache-keys.txt is written in main.ts (right after
  // resolveSetup) so workflow steps that run between main and post —
  // notably actions/upload-artifact — can read it. Re-write it here
  // anyway as a safety net in case main.ts crashed before writing.
  if (runnerTemp) {
    writeCacheKeysManifestFromSummary(finalSummary, runnerTemp, log);
  }

  // Append save ops to detailed session log if requested
  if (statsMode === "detailed" && runnerTemp) {
    try {
      await postCollector.appendSavesToSessionLog(runnerTemp);
    } catch (err) {
      log(`post: stats log append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Optional verbose diagnostic dump. Gated on `logging: true` which
  // main.ts persists into action state.
  const loggingState = core.getState("logging");
  if (loggingEnabled(loggingState)) {
    const rawInputs = readRawInputs(process.env);
    // zccache writes its per-rustc-invocation JSONL journal under the
    // build-cache directory (which == ZCCACHE_CACHE_DIR per
    // resolve-setup.ts's env exports). When `logging: true` is on we
    // surface its contents so the reader can answer "warm reported 0
    // hits — why did each lookup miss" without another build.
    const journalPath = path.join(result.buildCache.path, "logs", "last-session.jsonl");
    // Forward the verbatim `report` field from `soldr cache report --json`
    // so dumpDiagnostics can format its `rollups` (per-extension /
    // per-crate / slowest_entries) breakdown.
    const cacheReport = finalSummary.compile_cache_report.report;
    // Capture a process snapshot only when debug mode is on — `ps` /
    // `tasklist` are cheap but the output is large and only useful when
    // you're investigating cache-state weirdness (e.g. orphan daemons).
    const processSnapshot = debugMode ? captureProcessSnapshot() ?? undefined : undefined;
    dumpDiagnostics({
      phase: "post",
      env: process.env,
      rawInputs,
      result,
      cacheOutcomes: postCollector.snapshot(),
      finalSummary: finalSummary as unknown as Record<string, unknown>,
      journalPath,
      // Raw JSONL stream — one record per rustc invocation, often
      // thousands of lines / 20-30 MB of stdout per warm build. Default
      // gate is `debug:true` (backwards compat with #134 era), but a
      // workflow can explicitly opt out via `journal-print-raw: false`
      // when it already uploads the JSONL as an artifact and doesn't
      // want to pay the post-step log-writer cost (~30-50 s on the
      // hosted ubuntu demo).
      journalPrintRaw: resolveJournalPrintRaw(rawInputs.journalPrintRaw, debugMode),
      cacheReport,
      processSnapshot,
      logger,
      stepSummaryPath: process.env["GITHUB_STEP_SUMMARY"]?.trim() || undefined,
    });
  }
}

function writeCacheKeysManifestFromSummary(
  summary: FinalCacheSummary,
  runnerTemp: string,
  log: (msg: string) => void,
): void {
  const keys = [
    summary.setup_cache.key,
    summary.build_cache.key,
    summary.target_cache.key,
    summary.cargo_registry_cache.key,
  ].filter((k) => Boolean(k));
  if (keys.length === 0) return;
  const outPath = path.join(runnerTemp, "setup-soldr-cache-keys.txt");
  try {
    fs.writeFileSync(outPath, keys.join("\n") + "\n", "utf8");
    log(`cache-keys manifest written to ${outPath} (${keys.length} keys)`);
  } catch (err) {
    log(`post: failed to write cache-keys manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// See main.ts for the rationale behind the test-import escape hatch.
if (
  typeof process !== "undefined" &&
  !process.env["SETUP_SOLDR_TEST_IMPORT"]
) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    core.warning(`setup-soldr post-job step failed: ${message}`);
  });
}
