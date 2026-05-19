import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shutdownCacheDaemons } from "../src/lib/shutdown-cache.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("shutdownCacheDaemons logs and returns without throwing when nothing is installed", async () => {
  const logged: string[] = [];
  // Force a PATH with nothing on it so neither `zccache` nor any soldr is found.
  const previousPath = process.env["PATH"];
  process.env["PATH"] = mkTmp("empty-path-");
  try {
    await shutdownCacheDaemons({ log: (m) => logged.push(m) });
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  }
  assert.ok(
    logged.some((m) => m.includes("requesting daemon shutdown")),
    `expected shutdown announcement, got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    logged.some((m) => m.includes("zccache") && m.includes("not on PATH, skipping")),
    `expected zccache skip log, got: ${JSON.stringify(logged)}`,
  );
});

test("shutdownCacheDaemons attempts soldr stop when soldrPath is given", async () => {
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-soldr-");
  // Provide a fake soldr binary path that does not exist on disk; the
  // helper should still attempt to invoke it (absolute path bypasses
  // the PATH-exists check) and report the spawn error gracefully.
  const fakeSoldr = path.join(dir, "soldr-does-not-exist");
  try {
    await shutdownCacheDaemons({ soldrPath: fakeSoldr, log: (m) => logged.push(m) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(
    logged.some((m) => m.includes("soldr") && (m.includes("$") || m.includes("spawn failed") || m.includes("exit"))),
    `expected soldr invocation attempt, got: ${JSON.stringify(logged)}`,
  );
});
