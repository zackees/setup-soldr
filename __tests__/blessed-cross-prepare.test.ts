import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSingleCrossTarget,
  mergeToolchainTargets,
  planBlessedPrepareCache,
  prepareTargetsFor,
  blessedPrepareCacheKey,
  buildPrepareArgs,
  decideBlessedPrepareCacheUse,
  assertMinimumSoldrVersion,
  validateBlessedPrepareRestore,
} from "../src/lib/blessed-cross-prepare.js";

test("one canonical target is normalized and merged before cache planning", () => {
  const target = parseSingleCrossTarget(" X86_64-PC-WINDOWS-GNU ");
  assert.equal(target, "x86_64-pc-windows-gnu");
  assert.deepEqual(mergeToolchainTargets(["stable", "aarch64-unknown-linux-musl"], target), ["aarch64-unknown-linux-musl", "stable", "x86_64-pc-windows-gnu"]);
});

test("universal2 expands to real Rust targets for toolchain provisioning", () => {
  assert.deepEqual(mergeToolchainTargets([], "universal2-apple-darwin"), ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
  assert.deepEqual(prepareTargetsFor("universal2-apple-darwin").sort(), ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
  const cache = planBlessedPrepareCache({
    enabled: true,
    cacheEnabled: true,
    ref: "",
    runnerTemp: "temp",
    runnerOs: "Linux",
    runnerArch: "X64",
    target: "universal2-apple-darwin",
    soldrRepo: "zackees/soldr",
    soldrVersion: "0.8.39",
  });
  assert.equal(cache.archivePaths.length, 2);
  assert.match(cache.archivePaths[0]!, /x86_64-apple-darwin/);
  assert.match(cache.archivePaths[1]!, /aarch64-apple-darwin/);
});

test("multiple targets require a matrix", () => {
  assert.throws(() => parseSingleCrossTarget("x86_64-pc-windows-gnu,aarch64-unknown-linux-musl"), /use a matrix/);
});

test("friendly aliases and malformed targets are rejected", () => {
  assert.throws(() => parseSingleCrossTarget("macos-arm"), /canonical Rust target triple.*aliases.*not accepted/);
  assert.throws(() => parseSingleCrossTarget("not-a-target!"), /canonical Rust target triple.*aliases.*not accepted/);
  assert.throws(() => parseSingleCrossTarget("all"), /canonical Rust target triple.*aliases.*not accepted/);
});

test("prepared cache keys are immutable and target/identity keyed", () => {
  const base = { runnerOs: "Linux", runnerArch: "X64", target: "x86_64-pc-windows-gnu", soldrRepo: "zackees/soldr", soldrVersion: "0.8.39" };
  assert.equal(blessedPrepareCacheKey(base), blessedPrepareCacheKey(base));
  assert.notEqual(blessedPrepareCacheKey(base), blessedPrepareCacheKey({ ...base, target: "aarch64-unknown-linux-musl" }));
});

test("prepared cache falls back across Soldr releases without crossing host or target", () => {
  const common = {
    enabled: true,
    cacheEnabled: true,
    ref: "",
    runnerTemp: "temp",
    runnerOs: "Linux",
    runnerArch: "X64",
    target: "aarch64-unknown-linux-gnu",
    soldrRepo: "zackees/soldr",
  };
  const oldPlan = planBlessedPrepareCache({ ...common, soldrVersion: "0.9.4" });
  const newPlan = planBlessedPrepareCache({ ...common, soldrVersion: "0.9.5" });

  assert.notEqual(oldPlan.key, newPlan.key, "exact keys remain immutable per Soldr release");
  assert.deepEqual(newPlan.restoreKeys, oldPlan.restoreKeys);
  assert.equal(newPlan.restoreKeys.length, 1, "one repository-isolated stable v3 prefix");
  assert.ok(oldPlan.key.startsWith(newPlan.restoreKeys[0]!));

  const otherTarget = planBlessedPrepareCache({
    ...common,
    target: "x86_64-unknown-linux-gnu",
    soldrVersion: "0.9.5",
  });
  assert.notDeepEqual(newPlan.restoreKeys, otherTarget.restoreKeys);

  const fork = planBlessedPrepareCache({ ...common, soldrRepo: "someone/soldr", soldrVersion: "0.9.5" });
  assert.equal(fork.restoreKeys.length, 1);
  assert.ok(!fork.key.startsWith(newPlan.restoreKeys[0]!), "fork entries cannot match the official restore prefix");
  assert.ok(!newPlan.key.startsWith(fork.restoreKeys[0]!), "official entries cannot match a fork restore prefix");
});

test("prepare args use the installed binary and immutable archive mode", () => {
  assert.deepEqual(buildPrepareArgs({ target: "x86_64-pc-windows-gnu", githubEnv: "env", archivePath: "archive", save: true }), ["prepare", "--target", "x86_64-pc-windows-gnu", "--github-env", "env", "--save", "archive"]);
  assert.deepEqual(
    buildPrepareArgs({ target: "x86_64-pc-windows-gnu", archivePath: "archive", restore: true, save: true }),
    ["prepare", "--target", "x86_64-pc-windows-gnu", "--restore", "archive", "--save", "archive"],
    "fallback restores must be promoted after Soldr fills any version gaps",
  );
  assert.throws(() => assertMinimumSoldrVersion("0.8.42"), /0.8.43/);
  assert.doesNotThrow(() => assertMinimumSoldrVersion("0.8.43"));
});

test("fallback prepare restores old assets, fills gaps, and promotes the exact key", () => {
  assert.deepEqual(
    decideBlessedPrepareCacheUse({
      enabled: true,
      exactHit: false,
      matchedKey: "setup-soldr-prepare-v3-Linux-X64-target-old",
      archivesExist: true,
    }),
    { effectiveExactHit: false, fallbackHit: true, restore: true, save: true },
  );
  assert.deepEqual(
    decideBlessedPrepareCacheUse({
      enabled: true,
      exactHit: true,
      matchedKey: "setup-soldr-prepare-v3-Linux-X64-target-current",
      archivesExist: true,
    }),
    { effectiveExactHit: true, fallbackHit: false, restore: true, save: false },
  );
});

test("#475 blessed-prepare rejects a matched zero-byte archive with a warning", () => {
  const warnings: string[] = [];
  const result = validateBlessedPrepareRestore({
    hit: true,
    matchedKey: "setup-soldr-prepare-v3-exact",
    archivePaths: ["prepared.tar.zst"],
    exists: () => true,
    statSize: () => 0,
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(result, {
    hit: false,
    matchedKey: "",
    archiveBytes: 0,
    archivesUsable: false,
  });
  assert.ok(warnings.some((line) => line.includes("setup-soldr-prepare-v3-exact") && line.includes("archive=0B")));
});

test("#475 blessed-prepare requires every universal2 archive to be non-empty", () => {
  const result = validateBlessedPrepareRestore({
    hit: false,
    matchedKey: "setup-soldr-prepare-v3-fallback",
    archivePaths: ["x86_64.tar.zst", "aarch64.tar.zst"],
    exists: () => true,
    statSize: (file) => file.startsWith("x86_64") ? 42 : 0,
  });
  assert.equal(result.hit, false);
  assert.equal(result.matchedKey, "");
  assert.equal(result.archiveBytes, 42);
  assert.equal(result.archivesUsable, false);
});
