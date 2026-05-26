// Unit tests for the soldr-toolchain-client helper.
//
// This module is the single deserializer for the three JSON subcommands
// added in soldr 0.7.35:
//
//   soldr toolchain ensure --json
//   soldr toolchain link --shim-dir <path> --json
//   soldr toolchain doctor --json
//
// Each helper takes an injected `exec` callback so unit tests can simulate
// any JSON shape — including older soldr versions that do not implement the
// new subcommands.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectSoldrSupportsToolchainSubcommands,
  soldrToolchainEnsure,
  soldrToolchainLink,
  soldrToolchainDoctor,
  TOOLCHAIN_SUBCOMMANDS_MIN_VERSION,
} from "../src/lib/soldr-toolchain-client.js";

type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function mkExec(map: Record<string, { code?: number; stdout?: string; stderr?: string }>): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(" ");
    const entry = map[key];
    if (!entry) {
      return { code: 127, stdout: "", stderr: `mock exec: no entry for "${key}"` };
    }
    return {
      code: entry.code ?? 0,
      stdout: entry.stdout ?? "",
      stderr: entry.stderr ?? "",
    };
  };
}

// --- detectSoldrSupportsToolchainSubcommands ---

test("detectSoldrSupportsToolchainSubcommands returns true for soldr >= 0.7.35", async () => {
  const exec = mkExec({
    "version --json": {
      stdout: JSON.stringify({ soldr_version: "0.7.35", managed_zccache_version: "1.11.0" }),
    },
  });
  const result = await detectSoldrSupportsToolchainSubcommands("/fake/soldr", { exec });
  assert.equal(result.supported, true);
  assert.equal(result.soldrVersion, "0.7.35");
});

test("detectSoldrSupportsToolchainSubcommands returns true for soldr > 0.7.35", async () => {
  const exec = mkExec({
    "version --json": {
      stdout: JSON.stringify({ soldr_version: "0.8.0" }),
    },
  });
  const result = await detectSoldrSupportsToolchainSubcommands("/fake/soldr", { exec });
  assert.equal(result.supported, true);
});

test("detectSoldrSupportsToolchainSubcommands returns false for soldr < 0.7.35", async () => {
  const exec = mkExec({
    "version --json": {
      stdout: JSON.stringify({ soldr_version: "0.7.34" }),
    },
  });
  const result = await detectSoldrSupportsToolchainSubcommands("/fake/soldr", { exec });
  assert.equal(result.supported, false);
  assert.equal(result.soldrVersion, "0.7.34");
});

test("detectSoldrSupportsToolchainSubcommands returns false for passthrough stub", async () => {
  const exec = mkExec({
    "version --json": {
      stdout: JSON.stringify({ soldr_version: "passthrough", setup_soldr_passthrough: true }),
    },
  });
  const result = await detectSoldrSupportsToolchainSubcommands("/fake/soldr", { exec });
  assert.equal(result.supported, false);
});

test("detectSoldrSupportsToolchainSubcommands returns false when version command errors", async () => {
  const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "boom" });
  const result = await detectSoldrSupportsToolchainSubcommands("/fake/soldr", { exec });
  assert.equal(result.supported, false);
});

test("TOOLCHAIN_SUBCOMMANDS_MIN_VERSION is 0.7.35", () => {
  assert.equal(TOOLCHAIN_SUBCOMMANDS_MIN_VERSION, "0.7.35");
});

// --- soldrToolchainEnsure ---

test("soldrToolchainEnsure parses the schema_version=1 payload", async () => {
  const payload = {
    schema_version: 1,
    channel: "1.94.1",
    rustup_bootstrapped: false,
    components_added: ["rustfmt", "clippy"],
    targets_added: ["x86_64-pc-windows-gnu"],
    plugins_installed: ["cargo-zigbuild@0.18"],
    smoke_verify: { cargo_version: "cargo 1.94.1", rustc_version: "rustc 1.94.1", ok: true },
    elapsed_ms: 12345,
  };
  const exec = mkExec({
    "toolchain ensure --json": { stdout: JSON.stringify(payload) },
  });
  const result = await soldrToolchainEnsure("/fake/soldr", { exec });
  assert.notEqual(result, null);
  assert.equal(result!.channel, "1.94.1");
  assert.equal(result!.rustupBootstrapped, false);
  assert.deepEqual(result!.componentsAdded, ["rustfmt", "clippy"]);
  assert.deepEqual(result!.targetsAdded, ["x86_64-pc-windows-gnu"]);
  assert.deepEqual(result!.pluginsInstalled, ["cargo-zigbuild@0.18"]);
  assert.equal(result!.smokeVerify.ok, true);
});

test("soldrToolchainEnsure returns null and warns on schema_version mismatch", async () => {
  const exec = mkExec({
    "toolchain ensure --json": {
      stdout: JSON.stringify({ schema_version: 2, channel: "1.94.1" }),
    },
  });
  const warnings: string[] = [];
  const result = await soldrToolchainEnsure("/fake/soldr", {
    exec,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /schema_version/);
});

test("soldrToolchainEnsure returns null on non-zero exit", async () => {
  const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "unknown subcommand" });
  const result = await soldrToolchainEnsure("/fake/soldr", { exec });
  assert.equal(result, null);
});

test("soldrToolchainEnsure returns null on non-JSON output", async () => {
  const exec = mkExec({
    "toolchain ensure --json": { stdout: "not json" },
  });
  const result = await soldrToolchainEnsure("/fake/soldr", { exec });
  assert.equal(result, null);
});

test("soldrToolchainEnsure forwards channel/profile/components/targets when provided", async () => {
  const seen: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    seen.push([...args]);
    return {
      code: 0,
      stdout: JSON.stringify({
        schema_version: 1,
        channel: "1.94.1",
        rustup_bootstrapped: false,
        components_added: [],
        targets_added: [],
        plugins_installed: [],
        smoke_verify: { cargo_version: "x", rustc_version: "y", ok: true },
        elapsed_ms: 1,
      }),
      stderr: "",
    };
  };
  await soldrToolchainEnsure("/fake/soldr", {
    exec,
    channel: "1.94.1",
    profile: "minimal",
    components: ["rustfmt", "clippy"],
    targets: ["x86_64-pc-windows-gnu"],
  });
  assert.equal(seen.length, 1);
  const args = seen[0]!;
  assert.deepEqual(args.slice(0, 3), ["toolchain", "ensure", "--json"]);
  assert.ok(args.includes("--channel") && args[args.indexOf("--channel") + 1] === "1.94.1");
  assert.ok(args.includes("--profile") && args[args.indexOf("--profile") + 1] === "minimal");
  assert.ok(args.includes("--component"));
  assert.ok(args.includes("--target"));
});

// --- soldrToolchainLink ---

test("soldrToolchainLink parses the schema_version=1 payload", async () => {
  const payload = {
    schema_version: 1,
    shim_dir: "/runner/.setup-soldr/shims",
    tools: [
      { name: "cargo", shim_path: "/runner/.setup-soldr/shims/cargo", created: true },
      { name: "rustfmt", shim_path: "/runner/.setup-soldr/shims/rustfmt", created: true },
    ],
    elapsed_ms: 12,
  };
  const exec = mkExec({
    "toolchain link --shim-dir /tmp/shims --json": { stdout: JSON.stringify(payload) },
  });
  const result = await soldrToolchainLink("/fake/soldr", "/tmp/shims", { exec });
  assert.notEqual(result, null);
  assert.equal(result!.shimDir, "/runner/.setup-soldr/shims");
  assert.equal(result!.tools.length, 2);
  assert.equal(result!.tools[0]!.name, "cargo");
  assert.equal(result!.tools[0]!.created, true);
});

test("soldrToolchainLink returns null and warns on schema_version mismatch", async () => {
  const exec = mkExec({
    "toolchain link --shim-dir /tmp/shims --json": {
      stdout: JSON.stringify({ schema_version: 99, shim_dir: "/x", tools: [], elapsed_ms: 1 }),
    },
  });
  const warnings: string[] = [];
  const result = await soldrToolchainLink("/fake/soldr", "/tmp/shims", {
    exec,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /schema_version/);
});

test("soldrToolchainLink returns null on non-zero exit", async () => {
  const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "unknown subcommand: toolchain link" });
  const result = await soldrToolchainLink("/fake/soldr", "/tmp/shims", { exec });
  assert.equal(result, null);
});

// --- soldrToolchainDoctor ---

test("soldrToolchainDoctor parses the schema_version=1 payload", async () => {
  const payload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [
      { name: "musl-cc", ok: true, details: { triple: "x86_64-unknown-linux-musl" } },
      { name: "shared-target-warning", ok: true, details: { would_warn: false, target_dir: "target" } },
    ],
    elapsed_ms: 12,
  };
  const exec = mkExec({
    "toolchain doctor --json": { stdout: JSON.stringify(payload) },
  });
  const result = await soldrToolchainDoctor("/fake/soldr", { exec });
  assert.notEqual(result, null);
  assert.equal(result!.host.os, "linux");
  assert.equal(result!.probes.length, 2);
  assert.equal(result!.probes[0]!.name, "musl-cc");
  assert.equal(result!.probes[1]!.name, "shared-target-warning");
});

test("soldrToolchainDoctor returns null and warns on schema_version mismatch", async () => {
  const exec = mkExec({
    "toolchain doctor --json": {
      stdout: JSON.stringify({ schema_version: 42, host: {}, probes: [], elapsed_ms: 1 }),
    },
  });
  const warnings: string[] = [];
  const result = await soldrToolchainDoctor("/fake/soldr", {
    exec,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /schema_version/);
});

test("soldrToolchainDoctor returns null on non-zero exit", async () => {
  const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "unknown subcommand: toolchain doctor" });
  const result = await soldrToolchainDoctor("/fake/soldr", { exec });
  assert.equal(result, null);
});

test("soldrToolchainDoctor.findProbe locates a probe by name", async () => {
  const payload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [
      { name: "musl-cc", ok: true, details: { triple: "x86_64-unknown-linux-musl" } },
      { name: "shared-target-warning", ok: false, details: { would_warn: true } },
    ],
    elapsed_ms: 1,
  };
  const exec = mkExec({
    "toolchain doctor --json": { stdout: JSON.stringify(payload) },
  });
  const result = await soldrToolchainDoctor("/fake/soldr", { exec });
  assert.notEqual(result, null);
  const musl = result!.probes.find((p) => p.name === "musl-cc");
  assert.equal(musl?.ok, true);
  const shared = result!.probes.find((p) => p.name === "shared-target-warning");
  assert.equal(shared?.ok, false);
});
