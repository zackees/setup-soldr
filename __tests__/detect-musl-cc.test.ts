// Tests for detect-musl-cc.
//
// Covers the legacy in-process scan AND the delegation path via
// `soldr toolchain doctor --json` (added in soldr 0.7.35).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectMuslCcEnv,
  tryDelegateToSoldrDoctorMuslCc,
  tripleToCcRsSuffix,
} from "../src/lib/detect-musl-cc.js";

// --- Legacy in-process scan ---

test("tripleToCcRsSuffix converts dashes to underscores", () => {
  assert.equal(
    tripleToCcRsSuffix("aarch64-unknown-linux-musl"),
    "aarch64_unknown_linux_musl",
  );
});

test("detectMuslCcEnv returns [] when no musl gcc on PATH", () => {
  const env: Record<string, string | undefined> = { PATH: "" };
  const result = detectMuslCcEnv(env);
  assert.deepEqual(result, []);
});

test("detectMuslCcEnv finds triple in CARGO_BUILD_TARGET when binaries present", () => {
  const env: Record<string, string | undefined> = {
    PATH: "/fake/bin",
    CARGO_BUILD_TARGET: "x86_64-unknown-linux-musl",
  };
  const found = ["x86_64-unknown-linux-musl-gcc", "x86_64-unknown-linux-musl-g++", "x86_64-unknown-linux-musl-ar"];
  const result = detectMuslCcEnv(env, {
    findOnPath: (cmd) => (found.some((f) => cmd === f) ? `/fake/bin/${cmd}` : null),
    readDir: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.triple, "x86_64-unknown-linux-musl");
  assert.equal(result[0]?.exports["CC_x86_64_unknown_linux_musl"], "x86_64-unknown-linux-musl-gcc");
});

test("detectMuslCcEnv skips a triple when CC_<triple> is already set", () => {
  const env: Record<string, string | undefined> = {
    PATH: "/fake/bin",
    CARGO_BUILD_TARGET: "x86_64-unknown-linux-musl",
    CC_x86_64_unknown_linux_musl: "custom-cc",
  };
  const result = detectMuslCcEnv(env, {
    findOnPath: () => "/fake/bin/something",
    readDir: () => [],
  });
  assert.deepEqual(result, []);
});

// --- Delegation path (Wave 3.4 / setup-soldr#133) ---

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

function mkExec(map: Record<string, ExecResult>): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(" ");
    return map[key] ?? { code: 127, stdout: "", stderr: `mock: no entry for ${key}` };
  };
}

test("tryDelegateToSoldrDoctorMuslCc reads musl-cc probe from doctor JSON", async () => {
  const doctorPayload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [
      {
        name: "musl-cc",
        ok: true,
        details: {
          resolutions: [
            {
              triple: "x86_64-unknown-linux-musl",
              cc: "/usr/bin/x86_64-unknown-linux-musl-gcc",
              cxx: "/usr/bin/x86_64-unknown-linux-musl-g++",
              ar: "/usr/bin/x86_64-unknown-linux-musl-ar",
              exports: {
                CC_x86_64_unknown_linux_musl: "x86_64-unknown-linux-musl-gcc",
                CXX_x86_64_unknown_linux_musl: "x86_64-unknown-linux-musl-g++",
                AR_x86_64_unknown_linux_musl: "x86_64-unknown-linux-musl-ar",
              },
            },
          ],
        },
      },
    ],
    elapsed_ms: 3,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain doctor --json": { code: 0, stdout: JSON.stringify(doctorPayload), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorMuslCc({ soldrPath: "/fake/soldr", exec });
  assert.notEqual(result, null);
  assert.equal(result!.length, 1);
  assert.equal(result![0]!.triple, "x86_64-unknown-linux-musl");
  assert.equal(result![0]!.exports["CC_x86_64_unknown_linux_musl"], "x86_64-unknown-linux-musl-gcc");
});

test("tryDelegateToSoldrDoctorMuslCc returns [] (not null) when probe present but empty", async () => {
  const doctorPayload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [{ name: "musl-cc", ok: true, details: { resolutions: [] } }],
    elapsed_ms: 1,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain doctor --json": { code: 0, stdout: JSON.stringify(doctorPayload), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorMuslCc({ soldrPath: "/fake/soldr", exec });
  // empty list, but not null — delegation succeeded, just found nothing
  assert.deepEqual(result, []);
});

test("tryDelegateToSoldrDoctorMuslCc returns null for soldr 0.7.34", async () => {
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.34" }), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorMuslCc({ soldrPath: "/fake/soldr", exec });
  assert.equal(result, null);
});

test("tryDelegateToSoldrDoctorMuslCc returns null when probe missing", async () => {
  const doctorPayload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [{ name: "shared-target-warning", ok: true, details: {} }],
    elapsed_ms: 1,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain doctor --json": { code: 0, stdout: JSON.stringify(doctorPayload), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorMuslCc({ soldrPath: "/fake/soldr", exec });
  assert.equal(result, null);
});
