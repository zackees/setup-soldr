import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTargetHooks,
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

test("reusable target workflow has no legacy implementation selector", () => {
  const workflow = readFileSync(".github/workflows/target-lifecycle.yml", "utf8");
  assert.match(workflow, /soldr build --target/);
  assert.match(workflow, /soldr cargo clippy --target/);
  assert.match(workflow, /soldr cargo test --no-run --target/);
  assert.match(workflow, /python -m build --wheel/);
  assert.match(workflow, /python -m build --sdist/);
  assert.doesNotMatch(workflow, /cargo-(?:zigbuild|xwin)/);
});
