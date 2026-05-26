import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shutdownCacheDaemons } from "../src/lib/shutdown-cache.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface FakeSoldrOpts {
  /** Exit code the fake binary should return. */
  exitCode: number;
  /** Stderr text the fake binary should print before exiting. */
  stderr?: string;
  /** Optional log file the fake binary appends its argv to (one line per call). */
  argvLog?: string;
}

/**
 * Write a fake soldr executable that exits with the requested code and
 * stderr. Cross-platform: emits a .cmd on Windows, a /bin/sh script
 * elsewhere. Returns the absolute path to the fake binary.
 */
function writeFakeSoldr(dir: string, opts: FakeSoldrOpts): string {
  const isWindows = process.platform === "win32";
  const fakePath = path.join(dir, isWindows ? "soldr.cmd" : "soldr");
  const stderr = opts.stderr ?? "";
  if (isWindows) {
    // %* expands to all args; redirect via 1>&2 for stderr.
    const lines = ["@echo off"];
    if (opts.argvLog) {
      lines.push(`>>"${opts.argvLog}" echo %*`);
    }
    if (stderr) {
      // Escape special cmd characters; tests below pass plain ASCII.
      lines.push(`echo ${stderr} 1>&2`);
    }
    lines.push(`exit /b ${opts.exitCode}`);
    fs.writeFileSync(fakePath, lines.join("\r\n") + "\r\n", "utf8");
  } else {
    const lines = ["#!/bin/sh"];
    if (opts.argvLog) {
      lines.push(`echo "$*" >> "${opts.argvLog}"`);
    }
    if (stderr) {
      lines.push(`echo "${stderr}" 1>&2`);
    }
    lines.push(`exit ${opts.exitCode}`);
    fs.writeFileSync(fakePath, lines.join("\n") + "\n", "utf8");
    fs.chmodSync(fakePath, 0o755);
  }
  return fakePath;
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
  const ranSoldrStop = logged.some(
    (m) =>
      /\bsoldr\b[^\n]*\$[^\n]*\bstop\b(?!\w)/.test(m) &&
      !m.includes("cache shutdown") &&
      !m.includes("zccache"),
  );
  assert.ok(!ranSoldrStop, `must not invoke 'soldr stop'; saw: ${JSON.stringify(logged)}`);
});

test("shutdownCacheDaemons happy path: soldr cache shutdown succeeds, no fallback", async () => {
  // Modern soldr (post-#379) accepts `cache shutdown` and exits 0. We
  // should NOT try the zccache fallback after a clean exit.
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-happy-");
  try {
    const fakeSoldr = writeFakeSoldr(dir, { exitCode: 0 });
    // Empty PATH so any accidental fallback to `zccache` would log "not on PATH".
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
    logged.some((m) => m.includes("soldr") && m.includes("cache shutdown")),
    `expected soldr cache shutdown invocation, got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    !logged.some((m) => m.includes("zccache")),
    `must NOT fall back to zccache after a clean soldr exit, got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    !logged.some((m) => m.includes("not supported on this soldr version")),
    `must NOT log the fallback line after a clean soldr exit, got: ${JSON.stringify(logged)}`,
  );
});

test("shutdownCacheDaemons forwards --archive-logs to soldr when logsArchiveDir is set", async () => {
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-archive-");
  const argvLog = path.join(dir, "argv.log");
  try {
    const fakeSoldr = writeFakeSoldr(dir, { exitCode: 0, argvLog });
    const archiveDir = path.join(dir, "build-cache", "logs", "archive");
    await shutdownCacheDaemons({
      soldrPath: fakeSoldr,
      logsArchiveDir: archiveDir,
      log: (m) => logged.push(m),
    });
    const argvLine = fs.readFileSync(argvLog, "utf8").trim();
    assert.ok(
      argvLine.includes("cache") && argvLine.includes("shutdown"),
      `expected fake soldr to receive 'cache shutdown', got argv: ${argvLine}`,
    );
    assert.ok(
      argvLine.includes("--archive-logs"),
      `expected --archive-logs flag forwarded, got argv: ${argvLine}`,
    );
    assert.ok(
      argvLine.includes(archiveDir) ||
        // Windows .cmd %* normalizes paths in a couple cases; accept the
        // basename match as a fallback to keep the assertion portable.
        argvLine.includes("archive"),
      `expected archive dir in argv, got: ${argvLine}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(
    logged.some((m) => m.includes("--archive-logs")),
    `expected --archive-logs in the invocation log, got: ${JSON.stringify(logged)}`,
  );
});

test("shutdownCacheDaemons forwards --shutdown-timeout-seconds to soldr", async () => {
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-timeout-");
  const argvLog = path.join(dir, "argv.log");
  try {
    const fakeSoldr = writeFakeSoldr(dir, { exitCode: 0, argvLog });
    await shutdownCacheDaemons({
      soldrPath: fakeSoldr,
      shutdownTimeoutSeconds: 15,
      log: (m) => logged.push(m),
    });
    const argvLine = fs.readFileSync(argvLog, "utf8").trim();
    assert.ok(
      argvLine.includes("--shutdown-timeout-seconds") && argvLine.includes("15"),
      `expected shutdown timeout forwarded, got argv: ${argvLine}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(
    logged.some((m) => m.includes("--shutdown-timeout-seconds 15")),
    `expected timeout in invocation log, got: ${JSON.stringify(logged)}`,
  );
});

test("shutdownCacheDaemons falls back to zccache when soldr lacks the cache shutdown subcommand", async () => {
  // Simulate an older soldr by pointing soldrPath at a script that prints
  // "unrecognized subcommand" to stderr and exits 2 — matching soldr#379's
  // contract for "this CLI doesn't have cache shutdown yet."
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-fallback-");
  try {
    const fakeSoldr = writeFakeSoldr(dir, {
      exitCode: 2,
      stderr: "error: unrecognized subcommand 'shutdown'",
    });
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

test("shutdownCacheDaemons also treats unexpected shutdown argument as unsupported", async () => {
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-unexpected-");
  try {
    const fakeSoldr = writeFakeSoldr(dir, {
      exitCode: 2,
      stderr: "error: unexpected argument 'shutdown' found",
    });
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
});

test("shutdownCacheDaemons fallback invokes zccache stop", async () => {
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-zccache-stop-");
  const argvLog = path.join(dir, "zccache-argv.log");
  const isWindows = process.platform === "win32";
  const zccachePath = path.join(dir, isWindows ? "zccache.cmd" : "zccache");
  try {
    const fakeSoldr = writeFakeSoldr(dir, {
      exitCode: 2,
      stderr: "error: unrecognized subcommand 'shutdown'",
    });
    if (isWindows) {
      fs.writeFileSync(zccachePath, `@echo off\r\n>>"${argvLog}" echo %*\r\nexit /b 0\r\n`, "utf8");
    } else {
      fs.writeFileSync(zccachePath, `#!/bin/sh\necho "$*" >> "${argvLog}"\n`, "utf8");
      fs.chmodSync(zccachePath, 0o755);
    }
    const previousPath = process.env["PATH"];
    process.env["PATH"] = `${dir}${path.delimiter}${mkTmp("empty-path-")}`;
    try {
      await shutdownCacheDaemons({ soldrPath: fakeSoldr, log: (m) => logged.push(m) });
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
    assert.equal(fs.readFileSync(argvLog, "utf8").trim(), "stop");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(
    logged.some((m) => m.includes("zccache") && m.includes(" stop")),
    `expected zccache stop invocation, got: ${JSON.stringify(logged)}`,
  );
});

test("shutdownCacheDaemons does NOT fall back when soldr exits non-zero for a recognized command", async () => {
  // soldr knows `cache shutdown` but the daemon is wedged: exit 1, no
  // "unrecognized subcommand" stderr. We should log + return, NOT
  // double-trigger work via direct zccache.
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-recognized-err-");
  try {
    const fakeSoldr = writeFakeSoldr(dir, {
      exitCode: 1,
      stderr: "error: daemon refused shutdown request",
    });
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
    logged.some((m) => /soldr cache shutdown exited 1/.test(m)),
    `expected non-zero best-effort log, got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    !logged.some((m) => m.includes("zccache")),
    `must NOT attempt zccache fallback for a recognized-command failure, got: ${JSON.stringify(logged)}`,
  );
});

test("shutdownCacheDaemons throws for recognized soldr failure when failOnError is set", async () => {
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-required-");
  try {
    const fakeSoldr = writeFakeSoldr(dir, {
      exitCode: 1,
      stderr: "error: daemon refused shutdown request",
    });
    await assert.rejects(
      shutdownCacheDaemons({
        soldrPath: fakeSoldr,
        failOnError: true,
        log: (m) => logged.push(m),
      }),
      /shutdown-cache: soldr: exit 1/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdownCacheDaemons both paths fail: logs and continues best-effort", async () => {
  // soldr signals "I don't know cache shutdown" (clap exit 2 +
  // unrecognized-subcommand stderr) AND zccache is not on PATH. The
  // helper must log and return without throwing — losing the user's
  // cache save over a daemon hiccup is the opposite of what we want.
  const logged: string[] = [];
  const dir = mkTmp("shutdown-cache-both-fail-");
  try {
    const fakeSoldr = writeFakeSoldr(dir, {
      exitCode: 2,
      stderr: "error: unrecognized subcommand 'shutdown'",
    });
    const previousPath = process.env["PATH"];
    process.env["PATH"] = mkTmp("empty-path-");
    try {
      // Should not throw.
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
    `expected zccache skip log after fallback attempted, got: ${JSON.stringify(logged)}`,
  );
});
