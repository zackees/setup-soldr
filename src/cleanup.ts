// Mid-job setup-soldr cleanup entrypoint.
//
// This is intentionally separate from the post step. Self-build workflows can
// insert `zackees/setup-soldr/cleanup` between their builder phase and tests so
// tests do not inherit the builder's soldr-managed zccache daemon.

import * as core from "@actions/core";
import { parseBooleanInput, parseOptionalSeconds } from "./lib/cleanup-inputs.js";
import { shutdownCacheDaemons } from "./lib/shutdown-cache.js";

export async function run(): Promise<void> {
  const soldrPathInput = core.getInput("soldr-path").trim();
  const soldrPath = soldrPathInput || process.env["SOLDR_BINARY"]?.trim() || "soldr";
  const logsArchiveDir = core.getInput("archive-logs").trim() || undefined;
  const shutdownTimeoutSeconds = parseOptionalSeconds(
    "shutdown-timeout-seconds",
    core.getInput("shutdown-timeout-seconds"),
  );
  const failOnError = parseBooleanInput(
    "fail-on-error",
    core.getInput("fail-on-error"),
    true,
  );

  await shutdownCacheDaemons({
    soldrPath,
    logsArchiveDir,
    shutdownTimeoutSeconds,
    failOnError,
    log: (message) => core.info(message),
  });
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
