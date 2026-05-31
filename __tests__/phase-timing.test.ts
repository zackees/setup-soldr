import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  markPhase,
  finishPhase,
  setupPhaseSummaryOneLine,
  timeSubPhase,
} from "../src/lib/phase-timing.js";

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

test("setupPhaseSummaryOneLine returns '' when no phase env vars are set", () => {
  // Clean any potentially-set test env vars first.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SETUP_SOLDR_PHASE_") && key.endsWith("_START_MS")) {
      delete process.env[key];
    }
  }
  assert.equal(setupPhaseSummaryOneLine(["resolve", "toolchain"]), "");
});

test("setupPhaseSummaryOneLine computes durations between adjacent phase starts", () => {
  // Synthetic timeline: t0 → t0+5000ms → t0+8000ms → now.
  const t0 = Date.now() - 10_000;
  process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"] = String(t0);
  process.env["SETUP_SOLDR_PHASE_TOOLCHAIN_START_MS"] = String(t0 + 5000);
  process.env["SETUP_SOLDR_PHASE_COOK_START_MS"] = String(t0 + 8000);
  try {
    const line = setupPhaseSummaryOneLine(["resolve", "toolchain", "cook"]);
    // resolve: 5.0s, toolchain: 3.0s, cook: ~2s (now - t0 - 8000)
    assert.match(line, /^setup phase totals: resolve=5\.0s toolchain=3\.0s cook=\d+\.\ds total=\d+\.\ds$/);
  } finally {
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"];
    delete process.env["SETUP_SOLDR_PHASE_TOOLCHAIN_START_MS"];
    delete process.env["SETUP_SOLDR_PHASE_COOK_START_MS"];
  }
});

test("timeSubPhase records duration into SETUP_SOLDR_PHASE_<parent>_SUB_<name>_MS (#302)", async () => {
  await withGithubEnvAndOutput(async () => {
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_TOOLCHAIN_SPEC_MS"];
    const result = await timeSubPhase("resolve", "toolchain-spec", async () => {
      await new Promise((r) => setTimeout(r, 25));
      return 42;
    });
    assert.equal(result, 42);
    const raw = (process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_TOOLCHAIN_SPEC_MS"] ?? "").trim();
    assert.ok(raw, "env var should be set");
    const ms = Number(raw);
    assert.ok(ms >= 20 && ms < 5000, `expected 20<=ms<5000, got ${ms}`);
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_TOOLCHAIN_SPEC_MS"];
  });
});

test("timeSubPhase aggregates across multiple calls with the same name (#302)", async () => {
  await withGithubEnvAndOutput(async () => {
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_RUSTUP_PROBE_MS"];
    for (let i = 0; i < 3; i += 1) {
      await timeSubPhase("resolve", "rustup-probe", async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
    }
    const ms = Number((process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_RUSTUP_PROBE_MS"] ?? "").trim());
    assert.ok(ms >= 40, `aggregated ms should be ~45+, got ${ms}`);
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_RUSTUP_PROBE_MS"];
  });
});

test("timeSubPhase records duration even when body throws (#302)", async () => {
  await withGithubEnvAndOutput(async () => {
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_BOOM_MS"];
    await assert.rejects(
      timeSubPhase("resolve", "boom", async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("nope");
      }),
      /nope/,
    );
    const ms = Number((process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_BOOM_MS"] ?? "").trim());
    assert.ok(ms >= 5, `expected ms>=5, got ${ms}`);
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_BOOM_MS"];
  });
});

test("setupPhaseSummaryOneLine appends {sub=Xs} breakdown when parent ≥ 1s (#302)", () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SETUP_SOLDR_PHASE_")) delete process.env[key];
  }
  const t0 = Date.now() - 10_000;
  process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"] = String(t0);
  process.env["SETUP_SOLDR_PHASE_TOOLCHAIN_START_MS"] = String(t0 + 8000);
  // resolve sub-phase: 5s on rustup-probe, 2s on ws-hash → resolve total 8s.
  process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_RUSTUP_PROBE_MS"] = "5000";
  process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_WS_HASH_MS"] = "2000";
  try {
    const line = setupPhaseSummaryOneLine(["resolve", "toolchain"]);
    // resolve=8.0s {rustup-probe=5.0s ws-hash=2.0s}  — slowest first
    // Sub-phase names are canonicalized to underscore form via env-var
    // round-trip (rustup-probe → SETUP_SOLDR_PHASE_RESOLVE_SUB_RUSTUP_PROBE_MS
    // → "rustup_probe" on display). Slowest first.
    assert.match(
      line,
      /resolve=8\.0s \{rustup_probe=5\.0s ws_hash=2\.0s\}/,
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SETUP_SOLDR_PHASE_")) delete process.env[key];
    }
  }
});

test("setupPhaseSummaryOneLine suppresses sub-phase detail when parent < 1s (#302)", () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SETUP_SOLDR_PHASE_")) delete process.env[key];
  }
  const t0 = Date.now() - 100;
  process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"] = String(t0);
  process.env["SETUP_SOLDR_PHASE_TOOLCHAIN_START_MS"] = String(t0 + 50);
  process.env["SETUP_SOLDR_PHASE_RESOLVE_SUB_NOISE_MS"] = "20";
  try {
    const line = setupPhaseSummaryOneLine(["resolve", "toolchain"]);
    assert.equal(line.includes("{"), false, `should not include sub-phase detail: ${line}`);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SETUP_SOLDR_PHASE_")) delete process.env[key];
    }
  }
});

test("setupPhaseSummaryOneLine silently skips phases whose env var isn't set", () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SETUP_SOLDR_PHASE_") && key.endsWith("_START_MS")) {
      delete process.env[key];
    }
  }
  const t0 = Date.now() - 5000;
  process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"] = String(t0);
  // skip toolchain — only resolve + cook set
  process.env["SETUP_SOLDR_PHASE_COOK_START_MS"] = String(t0 + 2000);
  try {
    const line = setupPhaseSummaryOneLine(["resolve", "toolchain", "cook"]);
    // toolchain absent → just resolve + cook
    assert.match(line, /^setup phase totals: resolve=2\.0s cook=\d+\.\ds total=\d+\.\ds$/);
    assert.equal(line.includes("toolchain"), false);
  } finally {
    delete process.env["SETUP_SOLDR_PHASE_RESOLVE_START_MS"];
    delete process.env["SETUP_SOLDR_PHASE_COOK_START_MS"];
  }
});
