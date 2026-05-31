import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as core from "@actions/core";
import type { CacheOpStats, StatsMode } from "./types.js";

function fmtBytes(n: number | null): string {
  if (n === null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncKey(key: string, maxLen: number): string {
  if (!key) return "(no match)";
  if (key.length <= maxLen) return key;
  return `\u2026${key.slice(-(maxLen - 1))}`;
}

function ratioStr(archiveBytes: number | null, inflatedBytes: number | null): string {
  if (archiveBytes === null || inflatedBytes === null || inflatedBytes === 0) return "";
  return ` ratio=${(archiveBytes / inflatedBytes).toFixed(2)}`;
}

export class StatsCollector {
  private ops: CacheOpStats[] = [];

  record(op: CacheOpStats): void {
    this.ops.push(op);
  }

  summaryText(): string {
    const restoreOps = this.ops.filter((o) => o.operation === "restore");
    if (restoreOps.length === 0) return "";

    const CW = { cache: 20, status: 8, matched: 42, archive: 10, inflated: 10, files: 8, time: 7 };
    const header = [
      "cache".padEnd(CW.cache),
      "status".padEnd(CW.status),
      "matched-key".padEnd(CW.matched),
      "archive".padStart(CW.archive),
      "inflated".padStart(CW.inflated),
      "files".padStart(CW.files),
      "time".padStart(CW.time),
    ].join("  ");
    const rule = "\u2500".repeat(header.length);

    const rows = restoreOps.map((op) => {
      const status = op.hit ? "HIT" : op.matchedKey ? "FALLBACK" : "MISS";
      const matchedDisplay = op.hit
        ? truncKey(op.matchedKey, CW.matched - 4)
        : op.matchedKey
          ? `fallback: ${truncKey(op.matchedKey, CW.matched - 10)}`
          : "(no match)";
      return [
        op.label.padEnd(CW.cache),
        status.padEnd(CW.status),
        matchedDisplay.padEnd(CW.matched),
        fmtBytes(op.archiveBytes).padStart(CW.archive),
        fmtBytes(op.inflatedBytes).padStart(CW.inflated),
        (op.fileCount !== null ? String(op.fileCount) : "-").padStart(CW.files),
        fmtMs(op.durationMs).padStart(CW.time),
      ].join("  ");
    });

    const exactHits = restoreOps.filter((o) => o.hit).length;
    const anyHits = restoreOps.filter((o) => o.hit || Boolean(o.matchedKey)).length;
    const totalMs = restoreOps.reduce((s, o) => s + o.durationMs, 0);
    const footer = `${exactHits}/${restoreOps.length} exact-hit  ${anyHits}/${restoreOps.length} any-hit  total restore: ${fmtMs(totalMs)}`;

    return [header, rule, ...rows, rule, footer].join("\n");
  }

  /**
   * One-line aggregate of every recorded save op. Lets operators see at
   * a glance: how many layers actually saved, total uploaded bytes,
   * total wall-clock spent in the post step's save path. Complements
   * the existing per-restore [[summaryText]]. (#269 minimal cut)
   *
   * Returns "" when no save ops were recorded (every layer disabled or
   * exact-hit-skipped) so callers can `if (line) log(line)`.
   *
   * Example:
   *   `cache save totals: layers_saved=2/4 uploaded=1.25 GiB total_ms=24500`
   */
  saveSummaryOneLine(): string {
    const saveOps = this.ops.filter((o) => o.operation === "save");
    if (saveOps.length === 0) return "";
    const saved = saveOps.filter((o) => o.status === "saved");
    const totalBytes = saved.reduce(
      (s, o) => s + (o.archiveBytes ?? 0),
      0,
    );
    const totalMs = saveOps.reduce((s, o) => s + o.durationMs, 0);
    return `cache save totals: layers_saved=${saved.length}/${saveOps.length} uploaded=${fmtBytes(totalBytes)} total_ms=${totalMs}`;
  }

  detailedJson(): object {
    const restoreOps = this.ops.filter((o) => o.operation === "restore");
    const saveOps = this.ops.filter((o) => o.operation === "save");
    const exactHits = restoreOps.filter((o) => o.hit).length;
    const anyHits = restoreOps.filter((o) => o.hit || Boolean(o.matchedKey)).length;
    const totalRestoreMs = restoreOps.reduce((s, o) => s + o.durationMs, 0);
    return {
      summary: {
        totalCaches: restoreOps.length,
        exactHits,
        anyHits,
        misses: restoreOps.length - anyHits,
        totalRestoreMs,
        savedCaches: saveOps.length,
      },
      restores: restoreOps,
      saves: saveOps,
    };
  }

  private restoreLogLine(op: CacheOpStats): string {
    const status = op.hit ? "HIT" : op.matchedKey ? "FALLBACK" : "MISS";
    const matchStr = op.matchedKey ? ` matched=${op.matchedKey}` : "";
    const archStr = op.archiveBytes !== null ? ` archive=${fmtBytes(op.archiveBytes)}` : "";
    const inflStr = op.inflatedBytes !== null ? ` inflated=${fmtBytes(op.inflatedBytes)}` : "";
    const filesStr = op.fileCount !== null ? ` files=${op.fileCount}` : "";
    return `[restore] ${op.label.padEnd(20)} ${status.padEnd(8)} key=${op.key}${matchStr}${archStr}${inflStr}${filesStr}  ${op.timestamp}  ${fmtMs(op.durationMs)}`;
  }

  private saveLogLine(op: CacheOpStats): string {
    const statusStr = op.status ? ` status=${op.status}` : "";
    const archStr = op.archiveBytes !== null ? ` archive=${fmtBytes(op.archiveBytes)}` : "";
    const inflStr = op.inflatedBytes !== null ? ` inflated=${fmtBytes(op.inflatedBytes)}` : "";
    const filesStr = op.fileCount !== null ? ` files=${op.fileCount}` : "";
    const skippedStr = op.payload?.skipped && op.payload.skipped.length > 0
      ? ` skipped=${op.payload.skipped.map((s) => `${s.reason}:${s.count}`).join(",")}`
      : "";
    const ratio = ratioStr(op.archiveBytes, op.inflatedBytes);
    return `[save]    ${op.label.padEnd(20)}          key=${op.key}${statusStr}${archStr}${inflStr}${filesStr}${ratio}${skippedStr}  ${op.timestamp}  ${fmtMs(op.durationMs)}`;
  }

  async writeFiles(runnerTemp: string): Promise<void> {
    await fs.mkdir(runnerTemp, { recursive: true });
    const jsonPath = path.join(runnerTemp, "setup-soldr-stats.json");
    const logPath = path.join(runnerTemp, "setup-soldr-session.log");
    await fs.writeFile(jsonPath, JSON.stringify(this.detailedJson(), null, 2), "utf8");
    const restoreLines = this.ops
      .filter((o) => o.operation === "restore")
      .map((o) => this.restoreLogLine(o));
    await fs.writeFile(logPath, restoreLines.join("\n") + "\n", "utf8");
  }

  async appendSavesToSessionLog(runnerTemp: string): Promise<void> {
    const saveOps = this.ops.filter((o) => o.operation === "save");
    if (saveOps.length === 0) return;
    const logPath = path.join(runnerTemp, "setup-soldr-session.log");
    const lines = saveOps.map((o) => this.saveLogLine(o));
    await fs.appendFile(logPath, lines.join("\n") + "\n", "utf8").catch(() => undefined);
  }

  report(mode: StatsMode, log: (msg: string) => void): void {
    if (mode === "none") return;
    const summary = this.summaryText();
    if (summary) log(summary);
    if (mode === "detailed") {
      log(JSON.stringify(this.detailedJson(), null, 2));
    }
  }

  setGithubOutputs(): void {
    core.setOutput("stats-json", JSON.stringify(this.detailedJson()));
  }

  serialize(): string {
    return JSON.stringify({ ops: this.ops });
  }

  snapshot(): readonly CacheOpStats[] {
    return this.ops.slice();
  }

  static deserialize(s: string): StatsCollector {
    const c = new StatsCollector();
    try {
      const parsed = JSON.parse(s) as { ops: CacheOpStats[] };
      c.ops = Array.isArray(parsed.ops) ? parsed.ops : [];
    } catch {
      // empty collector
    }
    return c;
  }
}
