import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  shouldEmitSharedTargetWarning,
  targetDirHasCompiledArtifacts,
} from "../src/lib/detect-shared-target-warning.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("targetDirHasCompiledArtifacts returns false for missing dir", () => {
  assert.equal(targetDirHasCompiledArtifacts("/non/existent/path/setup-soldr"), false);
});

test("targetDirHasCompiledArtifacts returns false for empty target dir", () => {
  const root = mkTmp("dst-empty-");
  try {
    assert.equal(targetDirHasCompiledArtifacts(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetDirHasCompiledArtifacts returns false for empty deps dir", () => {
  const root = mkTmp("dst-empty-deps-");
  try {
    fs.mkdirSync(path.join(root, "debug", "deps"), { recursive: true });
    assert.equal(targetDirHasCompiledArtifacts(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetDirHasCompiledArtifacts returns true for deps/*.rmeta", () => {
  const root = mkTmp("dst-rmeta-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "libfoo-1234.rmeta"), "x");
    assert.equal(targetDirHasCompiledArtifacts(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetDirHasCompiledArtifacts finds rmeta in nested target shapes", () => {
  const root = mkTmp("dst-rmeta-deep-");
  try {
    const deps = path.join(root, "x86_64-unknown-linux-gnu", "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "libbar.rmeta"), "y");
    assert.equal(targetDirHasCompiledArtifacts(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldEmitSharedTargetWarning false when build cache disabled", () => {
  assert.equal(
    shouldEmitSharedTargetWarning({
      buildCacheEnabled: false,
      buildCacheMode: "once",
      targetCacheEnabled: true,
      targetDir: "/tmp",
    }),
    false,
  );
});

test("shouldEmitSharedTargetWarning false when build cache mode is not 'once'", () => {
  const root = mkTmp("dst-mode-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "lib.rmeta"), "z");
    assert.equal(
      shouldEmitSharedTargetWarning({
        buildCacheEnabled: true,
        buildCacheMode: "thin",
        targetCacheEnabled: true,
        targetDir: root,
      }),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldEmitSharedTargetWarning false when target cache disabled", () => {
  const root = mkTmp("dst-tc-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "lib.rmeta"), "z");
    assert.equal(
      shouldEmitSharedTargetWarning({
        buildCacheEnabled: true,
        buildCacheMode: "once",
        targetCacheEnabled: false,
        targetDir: root,
      }),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldEmitSharedTargetWarning true when all conditions hold", () => {
  const root = mkTmp("dst-emit-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "lib.rmeta"), "z");
    assert.equal(
      shouldEmitSharedTargetWarning({
        buildCacheEnabled: true,
        buildCacheMode: "once",
        targetCacheEnabled: true,
        targetDir: root,
      }),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
