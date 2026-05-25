// Tests for src/lib/cross-bootstrap.ts (MVP of setup-soldr#104).
//
// Scope of these tests:
//   - planCrossBootstrap is a pure planner; we exercise the supported
//     lanes (linux -> *-pc-windows-gnu, linux -> *-unknown-linux-musl),
//     the multi-target dedup behavior, the unsupported-lane warning path,
//     and the `cross-tool: none` short-circuit.
//   - parseCrossTargets / parseCrossTool round-trip a few representative
//     input shapes.
//
// We don't exercise executeCrossBootstrap here because it just dispatches
// to @actions/exec, which is exercised by the integration smoke in the
// composite action's own CI matrix.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossToolCachePathsFor,
  planCrossBootstrap,
  parseCrossTargets,
  parseCrossTool,
  toolsetFor,
} from "../src/lib/cross-bootstrap.js";

test("planCrossBootstrap: linux -> x86_64-pc-windows-gnu emits zigbuild + ziglang + rustup target add", () => {
  const plan = planCrossBootstrap({
    host: "linux",
    targets: ["x86_64-pc-windows-gnu"],
    tool: "auto",
  });
  assert.equal(plan.warnings.length, 0, `unexpected warnings: ${plan.warnings.join("; ")}`);
  assert.equal(plan.actions.length, 3, "expected three actions for one supported target");
  assert.deepEqual(
    plan.actions.map((a) => ({ kind: a.kind, payload: a.payload })),
    [
      { kind: "cargo-install", payload: "cargo-zigbuild" },
      { kind: "pip-install", payload: "ziglang" },
      { kind: "rustup-target-add", payload: "x86_64-pc-windows-gnu" },
    ],
  );
});

test("planCrossBootstrap: multi-target dedupes cargo-zigbuild + ziglang but emits one rustup target add per triple", () => {
  const plan = planCrossBootstrap({
    host: "linux",
    targets: ["x86_64-pc-windows-gnu", "aarch64-pc-windows-gnu"],
    tool: "auto",
  });
  assert.equal(plan.warnings.length, 0);
  // 1x cargo-install, 1x pip-install, 2x rustup-target-add = 4 actions total.
  assert.equal(plan.actions.length, 4, "expected dedup of shared installs across two targets");
  const cargoInstalls = plan.actions.filter((a) => a.kind === "cargo-install");
  const pipInstalls = plan.actions.filter((a) => a.kind === "pip-install");
  const rustupAdds = plan.actions.filter((a) => a.kind === "rustup-target-add");
  assert.equal(cargoInstalls.length, 1, "cargo-zigbuild install must dedupe");
  assert.equal(pipInstalls.length, 1, "ziglang install must dedupe");
  assert.equal(rustupAdds.length, 2, "rustup target add must run per triple");
  assert.deepEqual(
    rustupAdds.map((a) => a.payload),
    ["x86_64-pc-windows-gnu", "aarch64-pc-windows-gnu"],
  );
});

test("planCrossBootstrap: linux -> x86_64-unknown-linux-musl emits the same install set as windows-gnu", () => {
  const plan = planCrossBootstrap({
    host: "linux",
    targets: ["x86_64-unknown-linux-musl"],
    tool: "auto",
  });
  assert.equal(plan.warnings.length, 0);
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    ["cargo-install", "pip-install", "rustup-target-add"],
  );
  assert.equal(plan.actions[2]?.payload, "x86_64-unknown-linux-musl");
});

test("planCrossBootstrap: unsupported lane (windows -> apple-darwin) returns empty plan + a warning", () => {
  const plan = planCrossBootstrap({
    host: "windows",
    targets: ["x86_64-apple-darwin"],
    tool: "auto",
  });
  assert.equal(plan.actions.length, 0, "no install actions for unsupported lane");
  assert.equal(plan.warnings.length, 1, "exactly one warning for the one unsupported target");
  assert.match(plan.warnings[0] ?? "", /host=windows/);
  assert.match(plan.warnings[0] ?? "", /x86_64-apple-darwin/);
  assert.match(plan.warnings[0] ?? "", /#104/);
});

test("planCrossBootstrap: cross-tool=none short-circuits to empty plan with no warnings, even for supported lanes", () => {
  const plan = planCrossBootstrap({
    host: "linux",
    targets: ["x86_64-pc-windows-gnu"],
    tool: "none",
  });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.warnings.length, 0);
});

test("planCrossBootstrap: empty targets list returns empty plan", () => {
  const plan = planCrossBootstrap({ host: "linux", targets: [], tool: "auto" });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.warnings.length, 0);
});

test("planCrossBootstrap: mixed supported + unsupported targets emit installs and per-target warning", () => {
  const plan = planCrossBootstrap({
    host: "linux",
    targets: ["x86_64-pc-windows-gnu", "x86_64-pc-windows-msvc"],
    tool: "auto",
  });
  // Supported lane installs cargo-zigbuild + ziglang + rustup target add.
  assert.equal(plan.actions.length, 3);
  // Unsupported lane (msvc not in MVP) emits one warning.
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0] ?? "", /x86_64-pc-windows-msvc/);
});

test("parseCrossTargets handles newline-separated input", () => {
  const parsed = parseCrossTargets("x86_64-pc-windows-gnu\naarch64-pc-windows-gnu");
  assert.deepEqual(parsed, ["x86_64-pc-windows-gnu", "aarch64-pc-windows-gnu"]);
});

test("parseCrossTargets handles comma-separated input", () => {
  const parsed = parseCrossTargets("x86_64-pc-windows-gnu, aarch64-pc-windows-gnu");
  assert.deepEqual(parsed, ["x86_64-pc-windows-gnu", "aarch64-pc-windows-gnu"]);
});

test("parseCrossTargets dedupes and trims whitespace", () => {
  const parsed = parseCrossTargets("  x86_64-pc-windows-gnu \n x86_64-pc-windows-gnu , aarch64-pc-windows-gnu ");
  assert.deepEqual(parsed, ["x86_64-pc-windows-gnu", "aarch64-pc-windows-gnu"]);
});

test("parseCrossTargets returns empty array for empty/whitespace input", () => {
  assert.deepEqual(parseCrossTargets(""), []);
  assert.deepEqual(parseCrossTargets("   \n  ,  "), []);
});

test("parseCrossTool defaults to auto for empty/unknown values", () => {
  assert.equal(parseCrossTool(""), "auto");
  assert.equal(parseCrossTool("  "), "auto");
  assert.equal(parseCrossTool("bogus"), "auto");
});

test("parseCrossTool recognizes known values case-insensitively", () => {
  assert.equal(parseCrossTool("none"), "none");
  assert.equal(parseCrossTool("None"), "none");
  assert.equal(parseCrossTool("AUTO"), "auto");
  assert.equal(parseCrossTool("zigbuild"), "zigbuild");
  assert.equal(parseCrossTool("xwin"), "xwin");
  assert.equal(parseCrossTool("mingw"), "mingw");
});

// --------------------- per-lane toolset selection (setup-soldr#106) ---------------------
//
// `toolsetFor({host, target})` is the lookup table the per-(host, target)
// cache layer uses to know which tool binaries to cache for each lane. The
// returned `tools` set drives both the cache key (versioned tool names) and
// the install plan (cargo-install / pip-install identifiers).

test("toolsetFor: linux -> *-pc-windows-gnu requires cargo-zigbuild + ziglang", () => {
  const ts = toolsetFor({ host: "linux", target: "x86_64-pc-windows-gnu" });
  assert.deepEqual(ts.tools.sort(), ["cargo-zigbuild", "ziglang"]);
});

test("toolsetFor: linux -> *-unknown-linux-musl requires cargo-zigbuild + ziglang", () => {
  const ts = toolsetFor({ host: "linux", target: "aarch64-unknown-linux-musl" });
  assert.deepEqual(ts.tools.sort(), ["cargo-zigbuild", "ziglang"]);
});

test("toolsetFor: unsupported lane returns an empty toolset (no installs)", () => {
  // windows -> apple-darwin is unsupported by the MVP planner — toolsetFor
  // must reflect that with an empty `tools` array so the cache layer
  // produces a stable no-op slot rather than crashing.
  const ts = toolsetFor({ host: "windows", target: "x86_64-apple-darwin" });
  assert.deepEqual(ts.tools, []);
});

// --------------------- per-lane cache paths (setup-soldr#106) ---------------------
//
// crossToolCachePathsFor returns the on-disk paths the per-lane cache should
// archive on save and unpack on restore. These are the binaries dropped by
// executeCrossBootstrap: cargo-zigbuild lives at $CARGO_HOME/bin/cargo-zigbuild,
// ziglang lives under the Python install dir (we use a `.soldr-cross-tools`
// staging slot we own so cache shape stays predictable).

test("crossToolCachePathsFor: zigbuild lane returns $CARGO_HOME/bin/cargo-zigbuild + a staging dir", () => {
  const paths = crossToolCachePathsFor({
    host: "linux",
    target: "x86_64-pc-windows-gnu",
    cargoHome: "/home/runner/.cargo",
    cacheRoot: "/runner-tmp/setup-soldr",
  });
  // Must include the cargo-zigbuild binary under cargo bin.
  assert.ok(
    paths.some((p) => p.endsWith("cargo-zigbuild") || p.endsWith("cargo-zigbuild.exe")),
    `expected a cargo-zigbuild path in ${paths.join(", ")}`,
  );
  // Must include a dedicated staging slot for the lane so we can stash the
  // ziglang pip artifacts somewhere deterministic. Path must live under the
  // setup-soldr cache root so the slot is per-job-isolated.
  assert.ok(
    paths.some((p) => p.includes("setup-soldr")),
    `expected a setup-soldr-rooted staging path in ${paths.join(", ")}`,
  );
});

test("crossToolCachePathsFor: empty toolset lane returns empty paths (no-op cache)", () => {
  // Unsupported lanes (or `cross-tool: none`) should not allocate cache paths.
  const paths = crossToolCachePathsFor({
    host: "windows",
    target: "x86_64-apple-darwin",
    cargoHome: "/c/cargo",
    cacheRoot: "/c/setup-soldr",
  });
  assert.deepEqual(paths, []);
});

test("crossToolCachePathsFor: paths are deterministic across calls", () => {
  const a = crossToolCachePathsFor({
    host: "linux",
    target: "x86_64-unknown-linux-musl",
    cargoHome: "/home/runner/.cargo",
    cacheRoot: "/runner-tmp/setup-soldr",
  });
  const b = crossToolCachePathsFor({
    host: "linux",
    target: "x86_64-unknown-linux-musl",
    cargoHome: "/home/runner/.cargo",
    cacheRoot: "/runner-tmp/setup-soldr",
  });
  assert.deepEqual(a, b);
});
