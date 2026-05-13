import { test } from "node:test";
import assert from "node:assert/strict";

// Ensure main.ts does not auto-invoke its run() when imported under test.
process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

test("src/main.ts imports cleanly and exposes `run`", async () => {
  const mod = (await import("../src/main.js")) as { run?: () => Promise<void> };
  assert.equal(typeof mod.run, "function");
});

test("main.run is callable and returns a Promise", async () => {
  const mod = (await import("../src/main.js")) as { run: () => Promise<void> };
  // We don't drive it through to completion (it'd need a configured workspace,
  // network, etc). We just verify the entry point shape.
  const p = (() => {
    try {
      return mod.run();
    } catch (err) {
      // run is async but if it throws synchronously, swallow for the test.
      return Promise.reject(err);
    }
  })();
  assert.ok(p instanceof Promise);
  // Detach so unhandled rejection doesn't taint the test process.
  p.catch(() => undefined);
});
