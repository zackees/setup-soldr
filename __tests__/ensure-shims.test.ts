// Tests for ensure-shims, covering both the legacy in-TS shim-writing path
// and the delegation path to `soldr toolchain link --shim-dir <path> --json`
// added in soldr 0.7.35 (Wave 3.4 / setup-soldr#133).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureShimsLegacy,
  tryDelegateToSoldrToolchainLink,
} from "../src/lib/ensure-shims.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

function mkExec(map: Record<string, ExecResult>): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(" ");
    return map[key] ?? { code: 127, stdout: "", stderr: `mock: no entry for ${key}` };
  };
}

// --- Legacy in-TS path (unchanged behavior) ---

test("ensureShimsLegacy writes shims for every routed tool", async () => {
  const dir = mkTmp("setup-soldr-shims-");
  try {
    await ensureShimsLegacy({
      shimsDir: dir,
      soldrPath: "/fake/soldr",
      isWindows: process.platform === "win32",
      log: () => {},
    });
    const ext = process.platform === "win32" ? ".cmd" : "";
    for (const tool of ["cargo", "rustfmt", "clippy-driver", "rustc", "rustdoc"]) {
      const p = path.join(dir, `${tool}${ext}`);
      assert.ok(fs.statSync(p).isFile(), `${p} was created`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Delegation path (Wave 3.4 / setup-soldr#133) ---

test("tryDelegateToSoldrToolchainLink delegates when soldr 0.7.35 is installed", async () => {
  const linkPayload = {
    schema_version: 1,
    shim_dir: "/runner/.setup-soldr/shims",
    tools: [
      { name: "cargo", shim_path: "/runner/.setup-soldr/shims/cargo", created: true },
      { name: "rustfmt", shim_path: "/runner/.setup-soldr/shims/rustfmt", created: true },
      { name: "clippy-driver", shim_path: "/runner/.setup-soldr/shims/clippy-driver", created: true },
      { name: "rustc", shim_path: "/runner/.setup-soldr/shims/rustc", created: true },
      { name: "rustdoc", shim_path: "/runner/.setup-soldr/shims/rustdoc", created: true },
    ],
    elapsed_ms: 5,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain link --shim-dir /tmp/shims --json": {
      code: 0,
      stdout: JSON.stringify(linkPayload),
      stderr: "",
    },
  });
  const result = await tryDelegateToSoldrToolchainLink({
    soldrPath: "/fake/soldr",
    shimDir: "/tmp/shims",
    exec,
  });
  assert.notEqual(result, null);
  assert.equal(result!.tools.length, 5);
});

test("tryDelegateToSoldrToolchainLink returns null for soldr 0.7.34", async () => {
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.34" }), stderr: "" },
  });
  const result = await tryDelegateToSoldrToolchainLink({
    soldrPath: "/fake/soldr",
    shimDir: "/tmp/shims",
    exec,
  });
  assert.equal(result, null);
});

test("tryDelegateToSoldrToolchainLink returns null when soldr binary missing", async () => {
  const exec: ExecFn = async () => ({ code: 127, stdout: "", stderr: "ENOENT" });
  const result = await tryDelegateToSoldrToolchainLink({
    soldrPath: "/no/such/soldr",
    shimDir: "/tmp/shims",
    exec,
  });
  assert.equal(result, null);
});

test("tryDelegateToSoldrToolchainLink returns null for passthrough stub", async () => {
  const exec = mkExec({
    "version --json": {
      code: 0,
      stdout: JSON.stringify({ soldr_version: "passthrough", setup_soldr_passthrough: true }),
      stderr: "",
    },
  });
  const result = await tryDelegateToSoldrToolchainLink({
    soldrPath: "/fake/soldr",
    shimDir: "/tmp/shims",
    exec,
  });
  assert.equal(result, null);
});

test("tryDelegateToSoldrToolchainLink returns null on schema_version mismatch", async () => {
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain link --shim-dir /tmp/shims --json": {
      code: 0,
      stdout: JSON.stringify({ schema_version: 7, shim_dir: "/x", tools: [], elapsed_ms: 1 }),
      stderr: "",
    },
  });
  const warnings: string[] = [];
  const result = await tryDelegateToSoldrToolchainLink({
    soldrPath: "/fake/soldr",
    shimDir: "/tmp/shims",
    exec,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, null);
  assert.ok(warnings.some((w) => /schema_version/.test(w)));
});
