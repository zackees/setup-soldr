import { test } from "node:test";
import assert from "node:assert/strict";
import { versionTuple } from "../src/lib/verify-soldr.js";

test("versionTuple parses canonical semver", () => {
  assert.deepEqual(versionTuple("0.7.10"), { major: 0, minor: 7, patch: 10 });
  assert.deepEqual(versionTuple("v0.7.10"), { major: 0, minor: 7, patch: 10 });
  assert.deepEqual(versionTuple("1.2.3"), { major: 1, minor: 2, patch: 3 });
});

test("versionTuple strips pre-release suffix from patch", () => {
  assert.deepEqual(versionTuple("0.7.10-rc1"), { major: 0, minor: 7, patch: 10 });
  assert.deepEqual(versionTuple("1.0.0-alpha.3"), { major: 1, minor: 0, patch: 0 });
});

test("versionTuple returns null for malformed", () => {
  assert.equal(versionTuple(""), null);
  assert.equal(versionTuple("0.7"), null);
  assert.equal(versionTuple("not-a-version"), null);
  assert.equal(versionTuple("0.x.0"), null);
});

test("versionTuple ignores extra version parts beyond major/minor/patch", () => {
  // "0.7.10.4" is still valid; we only look at the first three.
  assert.deepEqual(versionTuple("0.7.10.4"), { major: 0, minor: 7, patch: 10 });
});
