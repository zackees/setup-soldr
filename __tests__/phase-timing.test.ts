import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { markPhase, finishPhase } from "../src/lib/phase-timing.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withGithubEnvAndOutput<T>(
  fn: (envPath: string, outputPath: string) => Promise<T>,
): Promise<T> {
  const root = mkTmp("phase-timing-");
  const envPath = path.join(root, "env");
  const outputPath = path.join(root, "output");
  fs.writeFileSync(envPath, "", "utf8");
  fs.writeFileSync(outputPath, "", "utf8");

  const previousEnv = process.env["GITHUB_ENV"];
  const previousOut = process.env["GITHUB_OUTPUT"];
  process.env["GITHUB_ENV"] = envPath;
  process.env["GITHUB_OUTPUT"] = outputPath;
  try {
    return await fn(envPath, outputPath);
  } finally {
    if (previousEnv === undefined) delete process.env["GITHUB_ENV"];
    else process.env["GITHUB_ENV"] = previousEnv;
    if (previousOut === undefined) delete process.env["GITHUB_OUTPUT"];
    else process.env["GITHUB_OUTPUT"] = previousOut;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("markPhase writes a SETUP_SOLDR_PHASE_<NAME>_START_MS line to $GITHUB_ENV", async () => {
  await withGithubEnvAndOutput(async (envPath) => {
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"];
    await markPhase("resolve");
    const content = fs.readFileSync(envPath, "utf8");
    // @actions/core uses a multi-line heredoc delimiter format.
    assert.match(content, /SETUP_SOLDR_PHASE_RESOLVE_START_MS<<ghadelimiter/);
    assert.match(content, /\r?\n\d+\r?\n/);
    // exportVariable also mutates process.env
    assert.ok(process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"]);
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"];
  });
});

test("markPhase normalizes non-alphanumeric phase names", async () => {
  await withGithubEnvAndOutput(async (envPath) => {
    delete process.env["SETUP_SOLDR_PHASE_BUILD_CACHE_START_MS"];
    await markPhase("build-cache");
    const content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /SETUP_SOLDR_PHASE_BUILD_CACHE_START_MS<<ghadelimiter/);
    delete process.env["SETUP_SOLDR_PHASE_BUILD_CACHE_START_MS"];
  });
});

test("finishPhase emits seconds with 3 decimal places", async () => {
  await withGithubEnvAndOutput(async (_envPath, outputPath) => {
    const start = Date.now() - 1500;
    process.env["SETUP_SOLDR_PHASE_VERIFY_START_MS"] = String(start);
    const seconds = await finishPhase("verify");
    assert.ok(seconds >= 1.0 && seconds < 60.0);
    const content = fs.readFileSync(outputPath, "utf8");
    assert.match(content, /verify_seconds<<ghadelimiter/);
    assert.match(content, /verify_milliseconds<<ghadelimiter/);
    assert.match(content, /\r?\n\d+\.\d{3}\r?\n/);
    delete process.env["SETUP_SOLDR_PHASE_VERIFY_START_MS"];
  });
});

test("finishPhase returns 0 when no marker is set", async () => {
  await withGithubEnvAndOutput(async (_envPath, outputPath) => {
    delete process.env["SETUP_SOLDR_PHASE_MISSING_START_MS"];
    const seconds = await finishPhase("missing");
    assert.equal(seconds, 0);
    const content = fs.readFileSync(outputPath, "utf8");
    assert.match(content, /missing_seconds<<ghadelimiter/);
    assert.match(content, /\r?\n0\.000\r?\n/);
  });
});

test("finishPhase handles invalid start values", async () => {
  await withGithubEnvAndOutput(async (_envPath, outputPath) => {
    process.env["SETUP_SOLDR_PHASE_BAD_START_MS"] = "garbage";
    const seconds = await finishPhase("bad");
    assert.equal(seconds, 0);
    const content = fs.readFileSync(outputPath, "utf8");
    assert.match(content, /bad_seconds<<ghadelimiter/);
    assert.match(content, /\r?\n0\.000\r?\n/);
    delete process.env["SETUP_SOLDR_PHASE_BAD_START_MS"];
  });
});
