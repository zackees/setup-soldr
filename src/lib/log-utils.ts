// Logger wiring. Owned by Agent 1 (called from every helper).
//
// Mirrors the Python log_utils.log() behavior: prefix each line with elapsed
// mm:ss from SETUP_SOLDR_LOG_START_EPOCH when timestamps are enabled. Reads
// SETUP_SOLDR_TIMESTAMPS to decide.

import * as core from "@actions/core";
import type { Logger } from "./types.js";

/**
 * Build a Logger that:
 *   - prefixes elapsed time when SETUP_SOLDR_TIMESTAMPS is truthy
 *   - writes warnings/errors via @actions/core's annotated channels
 *   - writes the rest to stdout via core.info()
 */
export function createLogger(env: Record<string, string | undefined> = process.env): Logger {
  void env;
  void core;
  throw new Error("not implemented: createLogger");
}

export function colorForceEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  void env;
  throw new Error("not implemented: colorForceEnvironment");
}
