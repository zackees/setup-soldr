import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertTargetOperationSupported,
  buildUniversal2TargetContract,
  buildTargetHooks,
  buildTargetOperationOutputs,
  mergeTargetEnvironment,
  normalizeTargetPlan,
} from "../src/lib/target-lifecycle.js";

const soldrPlan = {
  schema_version: 1,
  rust_triple: "x86_64-pc-windows-msvc",
  env: {
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: "clang",
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: "-C link-arg=/LIBPATH:C:\\sdk",
  },
  target_plan: {
    schema_version: 1,
    canonical_target: "x86_64-pc-windows-msvc",
    cache_identity: "windows-msvc/x86_64-pc-windows-msvc",
    supported_operations: ["prepare", "build", "clippy", "test-no-run", "pep517-wheel", "pep517-sdist"],
    toolchain: { family: "windows-msvc", linker: "lld-link" },
    environment: { keys: ["CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER"], path_prepend: true },
    platform: { identity: "windows-msvc/x86_64-pc-windows-msvc" },
  },
};

test("normalizeTargetPlan exposes a stable setup-soldr target contract", () => {
  const plan = normalizeTargetPlan("x86_64-pc-windows-msvc", soldrPlan);
  assert.equal(plan.canonicalTarget, "x86_64-pc-windows-msvc");
  assert.equal(plan.cacheIdentity, "windows-msvc/x86_64-pc-windows-msvc");
  assert.deepEqual(plan.supportedOperations, ["prepare", "build", "clippy", "test-no-run", "pep517-wheel", "pep517-sdist"]);
  assert.equal(plan.environment.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER, "clang");
});

test("mergeTargetEnvironment preserves caller flags while adding Soldr target flags", () => {
  const merged = mergeTargetEnvironment(
    { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: "-C debuginfo=1", CFLAGS_x86_64_pc_windows_msvc: "-DPROJECT" },
    soldrPlan.env,
  );
  assert.equal(
    merged.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS,
    "-C debuginfo=1 -C link-arg=/LIBPATH:C:\\sdk",
  );
  assert.equal(merged.CFLAGS_x86_64_pc_windows_msvc, "-DPROJECT");
  assert.equal(merged.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER, "clang");
});

test("buildTargetHooks use the Soldr front door for every target operation", () => {
  const hooks = buildTargetHooks("x86_64-pc-windows-msvc");
  assert.equal(hooks.build, "soldr build --target x86_64-pc-windows-msvc");
  assert.equal(hooks.clippy, "soldr cargo clippy --target x86_64-pc-windows-msvc");
  assert.equal(hooks.testNoRun, "soldr cargo test --no-run --target x86_64-pc-windows-msvc");
  assert.equal(hooks.pep517Wheel, "python -m build --wheel");
  assert.equal(hooks.pep517Sdist, "python -m build --sdist");
});

test("requested target operations must be reported by Soldr", () => {
  const plan = normalizeTargetPlan("x86_64-pc-windows-msvc", soldrPlan);
  assert.doesNotThrow(() => assertTargetOperationSupported(plan, "build"));
  assert.throws(
    () => assertTargetOperationSupported({ ...plan, supportedOperations: ["prepare"] }, "build"),
    /does not support requested operation 'build'.*reported: prepare/,
  );
});

test("universal2 publishes packaging capabilities while recording both real build plans", () => {
  const arm = normalizeTargetPlan("aarch64-apple-darwin", {
    rust_triple: "aarch64-apple-darwin",
    target_plan: {
      canonical_target: "aarch64-apple-darwin",
      cache_identity: "apple/aarch64",
      supported_operations: ["prepare", "build", "pep517-wheel", "pep517-sdist"],
    },
  });
  const x64 = normalizeTargetPlan("x86_64-apple-darwin", {
    rust_triple: "x86_64-apple-darwin",
    target_plan: {
      canonical_target: "x86_64-apple-darwin",
      cache_identity: "apple/x86_64",
      supported_operations: ["prepare", "build", "pep517-wheel", "pep517-sdist"],
    },
  });
  const universal = buildUniversal2TargetContract([x64, arm]);
  assert.equal(universal.canonicalTarget, "universal2-apple-darwin");
  assert.deepEqual(universal.supportedOperations, ["prepare", "pep517-wheel", "pep517-sdist"]);
  assert.equal(universal.supportedOperations.includes("build"), false);
  const realTargets = universal.toolchain.realTargets as Array<{ supportedOperations: string[] }>;
  assert.equal(realTargets.length, 2);
  assert.ok(realTargets.every((target) => target.supportedOperations.includes("build")));
  const outputs = buildTargetOperationOutputs("workspace", universal);
  assert.equal(outputs.artifactDirectory, "");
  assert.equal(outputs.build, "");
  assert.equal(outputs.clippy, "");
  assert.equal(outputs.testNoRun, "");
  assert.equal(outputs.pep517Wheel, "python -m build --wheel");
  assert.equal(outputs.pep517Sdist, "python -m build --sdist");
});

test("mergeTargetEnvironment preserves every target-scoped project flag", () => {
  const existing = {
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-C debuginfo=1",
    CFLAGS_aarch64_unknown_linux_gnu: "-DPROJECT_C",
    CXXFLAGS_aarch64_unknown_linux_gnu: "-DPROJECT_CXX",
    LDFLAGS_aarch64_unknown_linux_gnu: "-Wl,--project",
  };
  const planned = {
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-C link-arg=--sysroot=/sdk",
    CFLAGS_aarch64_unknown_linux_gnu: "--sysroot=/sdk",
    CXXFLAGS_aarch64_unknown_linux_gnu: "--sysroot=/sdk",
    LDFLAGS_aarch64_unknown_linux_gnu: "-Wl,--sysroot=/sdk",
  };

  const merged = mergeTargetEnvironment(existing, planned);
  for (const [key, value] of Object.entries(existing)) {
    assert.match(merged[key]!, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(merged[key]!, /sysroot/);
  }
});

test("reusable target workflow has no legacy implementation selector", () => {
  const workflow = readFileSync(".github/workflows/target-lifecycle.yml", "utf8");
  assert.match(workflow, /target-capabilities-json/);
  assert.match(workflow, /does not support requested operation/);
  assert.match(workflow, /soldr build --target/);
  assert.match(workflow, /soldr cargo clippy --target/);
  assert.match(workflow, /soldr cargo test --no-run --target/);
  assert.match(workflow, /python -m build --wheel/);
  assert.match(workflow, /python -m build --sdist/);
  assert.doesNotMatch(workflow, /cargo-(?:zigbuild|xwin)/);
});
