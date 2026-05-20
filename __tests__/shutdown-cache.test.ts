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

test("shutdownCacheDaemons attempts soldr cache shutdown when soldrPath is given", async () => {
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
    logged.some(
      (m) => m.includes("soldr") && m.includes("cache shutdown"),
    ),
    `expected 'soldr cache shutdown' invocation log, got: ${JSON.stringify(logged)}`,
  );
});

test("shutdownCacheDaemons never invokes the broken 'soldr stop' subcommand", async () => {
  // Regression guard for zackees/setup-soldr#126: `soldr stop` is not a real
  // subcommand — soldr interprets it as fetching a tool named "stop" from
  // misaka10987/stop, which always fails. The shutdown helper must never
  // attempt this command.
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-no-stop-");
  const fakeSoldr = path.join(dir, "soldr-does-not-exist");
  try {
    await shutdownCacheDaemons({ soldrPath: fakeSoldr, log: (m) => logged.push(m) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ranSoldrStop = logged.some((m) => /\bsoldr\b[^\n]*\$[^\n]*\bstop\b(?!\w)/.test(m) && !m.includes("cache shutdown") && !m.includes("--stop-server"));
  assert.ok(!ranSoldrStop, `must not invoke 'soldr stop'; saw: ${JSON.stringify(logged)}`);
});

test("shutdownCacheDaemons falls back to zccache when soldr lacks the cache shutdown subcommand", async () => {
  // Simulate an older soldr by pointing soldrPath at a script that prints
  // "unrecognized subcommand" to stderr and exits 2 — matching soldr#379's
  // contract for "this CLI doesn't have cache shutdown yet."
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-fallback-");
  const isWindows = process.platform === "win32";
  const fakeSoldr = path.join(dir, isWindows ? "soldr.cmd" : "soldr");
  try {
    if (isWindows) {
      fs.writeFileSync(
        fakeSoldr,
        `@echo off\r\necho error: unrecognized subcommand '%2' 1>&2\r\nexit /b 2\r\n`,
        "utf8",
      );
    } else {
      fs.writeFileSync(
        fakeSoldr,
        `#!/bin/sh\necho "error: unrecognized subcommand '$2'" 1>&2\nexit 2\n`,
        "utf8",
      );
      fs.chmodSync(fakeSoldr, 0o755);
    }
    // Force a PATH with nothing on it so the zccache fallback also reports
    // skipped (we just want to confirm it WAS attempted after the soldr
    // path returned the unknown-subcommand signal).
    const previousPath = process.env["PATH"];
    process.env["PATH"] = mkTmp("empty-path-");
    try {
      await shutdownCacheDaemons({ soldrPath: fakeSoldr, log: (m) => logged.push(m) });
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(
    logged.some((m) => m.includes("not supported on this soldr version")),
    `expected fallback log line, got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    logged.some((m) => m.includes("zccache") && m.includes("not on PATH, skipping")),
    `expected zccache fallback attempt, got: ${JSON.stringify(logged)}`,
  );
});
