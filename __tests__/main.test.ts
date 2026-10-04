import { test } from "node:test";
import "./yank-audit.test.ts";
import assert from "node:assert/strict";

// Ensure main.ts does not auto-invoke its run() when imported under test.
process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

test("src/main.ts imports cleanly and exposes `run`", async () => {
  const mod = (await import("../src/main.js")) as { run?: () => Promise<void> };
  assert.equal(typeof mod.run, "function");
});

test("main.run is callable and returns a Promise", async () => {
  const mod = (await import("../src/main.js")) as { run: () => Promise<void> };
  // Exercise the Promise contract to completion without provisioning tools.
  // A detached real run otherwise keeps this worker alive while installing
  // a toolchain and can continue mutating state after the test has passed.
  const previous = process.env["SETUP_SOLDR_DRY_RUN"];
  process.env["SETUP_SOLDR_DRY_RUN"] = "1";
  try {
    const result = mod.run();
    assert.ok(result instanceof Promise);
    await result;
  } finally {
    if (previous === undefined) delete process.env["SETUP_SOLDR_DRY_RUN"];
    else process.env["SETUP_SOLDR_DRY_RUN"] = previous;
  }
});

test("cargo-registry encryption failures honor skip only for legacy-v1", async () => {
  const mod = (await import("../src/main.js")) as {
    shouldSkipCargoRegistryExtractionError: (
      err: unknown,
      format: "legacy-v1" | "soldr-v2",
      onFailure: string,
    ) => boolean;
  };
  for (const code of ["EAUTHFAIL", "EENCNOKEY"]) {
    const err = Object.assign(new Error(code), { code });
    assert.equal(mod.shouldSkipCargoRegistryExtractionError(err, "legacy-v1", "skip"), true);
    assert.equal(mod.shouldSkipCargoRegistryExtractionError(err, "legacy-v1", "error"), false);
    assert.equal(mod.shouldSkipCargoRegistryExtractionError(err, "soldr-v2", "skip"), false);
  }
  assert.equal(
    mod.shouldSkipCargoRegistryExtractionError(
      Object.assign(new Error("corrupt"), { code: "EBADARCHIVE" }),
      "legacy-v1",
      "skip",
    ),
    false,
  );
});
