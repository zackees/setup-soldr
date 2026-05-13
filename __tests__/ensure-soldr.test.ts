import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureSoldr } from "../src/lib/ensure-soldr.js";

// Most of ensure-soldr's logic depends on external HTTP + subprocess, both of
// which we don't want to actually exercise in unit tests. We focus on the
// "module imports & exports the entry point" contract here and on the rest
// indirectly via main.test.ts which mocks ensureSoldr entirely.

test("ensureSoldr is an async function with one argument", () => {
  assert.equal(typeof ensureSoldr, "function");
  assert.equal(ensureSoldr.length, 1);
});

test("ensureSoldr rejects with a clear message for unknown arch (mocked)", async () => {
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    Object.defineProperty(process, "arch", { value: "mips" as NodeJS.Architecture, configurable: true });
    // We expect the underlying detectTarget to throw.
    const resolveResult = {
      soldrPath: "/tmp/soldr-bin/soldr",
      soldrRepo: "zackees/soldr",
      soldrRef: "",
      soldrVersionRequested: "",
      soldrVersionResolved: "v0.7.16",
    } as Parameters<typeof ensureSoldr>[0]["resolveResult"];
    await assert.rejects(
      ensureSoldr({ resolveResult, githubToken: "" }),
      /unsupported architecture/,
    );
  } finally {
    if (originalArch) Object.defineProperty(process, "arch", originalArch);
  }
});
