import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSingleCrossTarget,
  mergeToolchainTargets,
  blessedPrepareCacheKey,
  buildPrepareArgs,
  assertMinimumSoldrVersion,
} from "../src/lib/blessed-cross-prepare.js";

test("one canonical target is normalized and merged before cache planning", () => {
  const target = parseSingleCrossTarget(" X86_64-PC-WINDOWS-GNU ");
  assert.equal(target, "x86_64-pc-windows-gnu");
  assert.deepEqual(mergeToolchainTargets(["stable", "aarch64-unknown-linux-musl"], target), ["aarch64-unknown-linux-musl", "stable", "x86_64-pc-windows-gnu"]);
});

test("multiple targets require a matrix", () => {
  assert.throws(() => parseSingleCrossTarget("x86_64-pc-windows-gnu,aarch64-unknown-linux-musl"), /use a matrix/);
});

test("prepared cache keys are immutable and target/identity keyed", () => {
  const base = { runnerOs: "Linux", runnerArch: "X64", target: "x86_64-pc-windows-gnu", soldrRepo: "zackees/soldr", soldrVersion: "0.8.39" };
  assert.equal(blessedPrepareCacheKey(base), blessedPrepareCacheKey(base));
  assert.notEqual(blessedPrepareCacheKey(base), blessedPrepareCacheKey({ ...base, target: "aarch64-unknown-linux-musl" }));
});

test("prepare args use the installed binary and immutable archive mode", () => {
  assert.deepEqual(buildPrepareArgs({ target: "x86_64-pc-windows-gnu", githubEnv: "env", archivePath: "archive", save: true }), ["prepare", "--target", "x86_64-pc-windows-gnu", "--github-env", "env", "--save", "archive"]);
  assert.throws(() => assertMinimumSoldrVersion("0.8.38"), /0.8.39/);
  assert.doesNotThrow(() => assertMinimumSoldrVersion("0.8.40"));
});
