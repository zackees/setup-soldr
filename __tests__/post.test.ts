import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("src/post.ts imports cleanly and exposes `run`", async () => {
  const mod = (await import("../src/post.js")) as { run?: () => Promise<void> };
  assert.equal(typeof mod.run, "function");
});

test("post.run no-ops when no resolveResult state present", async () => {
  const mod = (await import("../src/post.js")) as { run: () => Promise<void> };
  // Make sure GITHUB_STATE points at a temp file with no key set.
  const root = mkTmp("post-empty-state-");
  try {
    const statePath = path.join(root, "state");
    fs.writeFileSync(statePath, "", "utf8");
    const previousState = process.env["GITHUB_STATE"];
    process.env["GITHUB_STATE"] = statePath;
    try {
      await mod.run();
    } finally {
      if (previousState === undefined) delete process.env["GITHUB_STATE"];
      else process.env["GITHUB_STATE"] = previousState;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // No assertion beyond "did not throw" — the function should silently exit
  // when there's nothing to save.
});

test("post.run parses bad state gracefully", async () => {
  const mod = (await import("../src/post.js")) as { run: () => Promise<void> };
  // Inject malformed JSON via STATE_resolveResult (the @actions/core
  // toolkit env-var naming convention for getState/saveState).
  const prev = process.env["STATE_resolveResult"];
  process.env["STATE_resolveResult"] = "{not valid json";
  try {
    await mod.run();
  } finally {
    if (prev === undefined) delete process.env["STATE_resolveResult"];
    else process.env["STATE_resolveResult"] = prev;
  }
});
