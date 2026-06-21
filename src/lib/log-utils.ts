// Logger wiring. Owned by Agent 1 (called from every helper).
//
// Mirrors the Python log_utils.log() behavior: prefix each line with elapsed
// time from SETUP_SOLDR_LOG_START_EPOCH when timestamps are enabled. Reads
// SETUP_SOLDR_TIMESTAMPS to decide whether to prefix at all, and
// SETUP_SOLDR_TIMESTAMP_FORMAT to choose between `mmss` (default, e.g.
// "00:08") and `seconds` (two-decimal seconds, e.g. "8.04"). See issue #387
// Feature 2 for the decimal-seconds format rationale.

import * as core from "@actions/core";
import * as fs from "node:fs";
import type { Logger } from "./types.js";

function makeFileLogger(env: Record<string, string | undefined>): ((line: string) => void) | null {
  const logPath = (env["SETUP_SOLDR_LOG"] ?? "").trim();
  if (!logPath) return null;
  return (line: string): void => {
    try {
      fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {
      // best-effort
    }
  };
}

const FALSY_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

export type TimestampFormat = "mmss" | "seconds";
const VALID_TIMESTAMP_FORMATS: ReadonlySet<TimestampFormat> = new Set(["mmss", "seconds"]);

// Per-process fallback start epoch (seconds since epoch), mirrors the
// _FALLBACK_START semantics in log_utils.py: captured once at module load.
const FALLBACK_START_SECONDS = Date.now() / 1000;

function timestampsEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["SETUP_SOLDR_TIMESTAMPS"] ?? "true";
  const value = raw.trim().toLowerCase();
  return !FALSY_VALUES.has(value);
}

function timestampFormat(env: Record<string, string | undefined>): TimestampFormat {
  const raw = (env["SETUP_SOLDR_TIMESTAMP_FORMAT"] ?? "").trim().toLowerCase();
  if (VALID_TIMESTAMP_FORMATS.has(raw as TimestampFormat)) {
    return raw as TimestampFormat;
  }
  return "mmss";
}

function startEpoch(env: Record<string, string | undefined>): number {
  const raw = (env["SETUP_SOLDR_LOG_START_EPOCH"] ?? "").trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return FALLBACK_START_SECONDS;
}

function elapsedPrefix(env: Record<string, string | undefined>): string {
  const format = timestampFormat(env);
  if (format === "seconds") {
    // Two-decimal seconds since step start (e.g. "0.01", "12.87"). Monotonic
    // within a step because startEpoch is fixed at process start.
    const now = Date.now() / 1000;
    const elapsed = Math.max(0, now - startEpoch(env));
    return elapsed.toFixed(2);
  }
  // mmss (default, byte-identical to pre-#387 behavior).
  const now = Date.now() / 1000;
  const elapsed = Math.max(0, Math.floor(now - startEpoch(env)));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatLine(env: Record<string, string | undefined>, message: string): string {
  if (timestampsEnabled(env)) {
    return `${elapsedPrefix(env)} ${message}`;
  }
  return message;
}

/**
 * Build a Logger that:
 *   - prefixes elapsed time when SETUP_SOLDR_TIMESTAMPS is truthy
 *   - writes warnings/errors via @actions/core's annotated channels
 *   - writes the rest to stdout via core.info()
 *   - optionally appends each log/info line to SETUP_SOLDR_LOG file
 */
export function createLogger(env: Record<string, string | undefined> = process.env): Logger {
  const fileLog = makeFileLogger(env);
  return {
    info(msg: string): void {
      // Use stdout directly so the message reaches the runner log without
      // being annotated as info; mirrors log_utils.log() behavior.
      process.stdout.write(`${msg}\n`);
      if (fileLog) fileLog(msg);
    },
    warning(msg: string): void {
      core.warning(msg);
    },
    error(msg: string): void {
      core.error(msg);
    },
    debug(msg: string): void {
      core.debug(msg);
    },
    log(msg: string): void {
      const formatted = formatLine(env, msg);
      process.stdout.write(`${formatted}\n`);
      if (fileLog) fileLog(formatted);
    },
  };
}

/**
 * Mirror of log_utils.color_force_environment(): produce the set of env vars
 * to inject when timestamps are enabled and NO_COLOR is not already set.
 * Returns only the keys that should be added (caller decides how to merge).
 */
export function colorForceEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const additions: Record<string, string> = {};
  if (!timestampsEnabled(env)) {
    return additions;
  }
  if (env["NO_COLOR"] !== undefined) {
    return additions;
  }
  if (env["CARGO_TERM_COLOR"] === undefined) {
    additions["CARGO_TERM_COLOR"] = "always";
  }
  if (env["CLICOLOR_FORCE"] === undefined) {
    additions["CLICOLOR_FORCE"] = "1";
  }
  if (env["FORCE_COLOR"] === undefined) {
    additions["FORCE_COLOR"] = "1";
  }
  return additions;
}

/**
 * Test/library helper: format a single line using the supplied env.
 * Exported so cache-keys/resolve-setup can reuse the elapsed prefix logic
 * without instantiating a Logger.
 */
export function formatLogLine(env: Record<string, string | undefined>, message: string): string {
  return formatLine(env, message);
}

/**
 * Test helper: report whether the given env enables timestamped output.
 */
export function isTimestampsEnabled(env: Record<string, string | undefined>): boolean {
  return timestampsEnabled(env);
}

/**
 * Test/library helper: report the active timestamp format. Resolves invalid
 * or empty SETUP_SOLDR_TIMESTAMP_FORMAT to the default `mmss`.
 */
export function getTimestampFormat(env: Record<string, string | undefined>): TimestampFormat {
  return timestampFormat(env);
}
