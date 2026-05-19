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
import { createLogger } from "./lib/log-utils.js";
import { shutdownCacheDaemons } from "./lib/shutdown-cache.js";
import { StatsCollector } from "./lib/stats-collector.js";
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
}): Promise<CacheSaveResult & { archiveBytes: number | null }> {
  const { cacheDir, codec, level, key, matchedKey, label, debug, log } = opts;
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
    const result = await compressCache({ cacheDir, codec, level, debug, log });
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
      save: notManagedSave(),
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
  await shutdownCacheDaemons({
    soldrPath: process.env["SOLDR_BINARY"]?.trim() || undefined,
    log,
  });

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

  // Cargo registry cache (only when enabled)
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

  const finalSummary = buildFinalCacheSummary(
    result,
    restoreState,
    {
      buildCache: buildSave,
      cargoRegistryCache: cargoRegistrySave,
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

  // Append save ops to detailed session log if requested
  if (statsMode === "detailed" && runnerTemp) {
    try {
      await postCollector.appendSavesToSessionLog(runnerTemp);
    } catch (err) {
      log(`post: stats log append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
