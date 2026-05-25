import { test } from "node:test";

// Gated self-test for the per-test timeout watchdog wired into `npm test`
// via Node's built-in `--test-timeout=120000` flag. Normally skipped.
//
// To verify the watchdog aborts a hung test, run:
//
//   SETUP_SOLDR_WATCHDOG_SELF_TEST=1 npm test 2>&1 | grep "test timed out"
//
// The deliberate hang below should be aborted by node:test at ~2 min with
// a stack trace pointing back at this file. Do not enable this in CI — it
// intentionally never returns.

const ENABLED = process.env.SETUP_SOLDR_WATCHDOG_SELF_TEST === "1";

test(
  "watchdog: deliberate hang should be aborted by --test-timeout",
  { skip: !ENABLED },
  async () => {
    await new Promise(() => {
      /* hang forever — node:test should abort us via --test-timeout */
    });
  },
);
