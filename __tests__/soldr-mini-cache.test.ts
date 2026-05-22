// Tests for src/lib/soldr-mini-cache.ts.
//
// Pure-function coverage. The actual cache restore/save round trip is
// validated end-to-end by the demo workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMiniCacheKey, isEligibleForMiniCache } from "../src/lib/soldr-mini-cache.js";

test("buildMiniCacheKey shape includes only the coarse dimensions", () => {
  const key = buildMiniCacheKey({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    soldrVersion: "0.7.28",
  });
  assert.equal(key, "soldr-mini-linux-x64-glibc-v0.7.28");
});

test("buildMiniCacheKey strips a leading v from the version", () => {
  // Some upstream code paths surface the resolved version with a leading
  // "v" (e.g. "v0.7.28" from GH release tags). The key should normalize.
  const withV = buildMiniCacheKey({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    soldrVersion: "v0.7.28",
  });
  const withoutV = buildMiniCacheKey({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    soldrVersion: "0.7.28",
  });
  assert.equal(withV, withoutV);
  assert.equal(withV, "soldr-mini-linux-x64-glibc-v0.7.28");
});

test("buildMiniCacheKey is content-addressable — same inputs always produce same key", () => {
  const parts = {
    runnerOs: "macos",
    runnerArch: "arm64",
    libc: "darwin",
    soldrVersion: "0.7.28",
  };
  assert.equal(buildMiniCacheKey(parts), buildMiniCacheKey(parts));
});

test("buildMiniCacheKey does NOT include suffix, toolchain, or Cargo.lock dimensions", () => {
  // This pins the design contract from the soldr-mini-cache rationale:
  // the key must stay coarse so cross-workflow sharing works.
  const key = buildMiniCacheKey({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    soldrVersion: "0.7.28",
  });
  // Must not match any of these:
  assert.ok(!key.includes("rustc"));
  assert.ok(!key.includes("lockHash") && !key.includes("Cargo"));
  assert.ok(!key.includes("zccache-demo"));
  assert.ok(!key.includes("suffix"));
});

test("isEligibleForMiniCache disables when enable=false", () => {
  const r = isEligibleForMiniCache({ hasRef: false, enable: false, resolvedVersion: "0.7.28" });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /enable=false/);
});

test("isEligibleForMiniCache disables when ref is set", () => {
  const r = isEligibleForMiniCache({ hasRef: true, enable: true, resolvedVersion: "0.7.28" });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /ref is set/);
});

test("isEligibleForMiniCache disables when version unresolved", () => {
  const r = isEligibleForMiniCache({ hasRef: false, enable: true, resolvedVersion: "" });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no resolved version/);
});

test("isEligibleForMiniCache enables for default case", () => {
  const r = isEligibleForMiniCache({ hasRef: false, enable: true, resolvedVersion: "0.7.28" });
  assert.equal(r.eligible, true);
  assert.equal(r.reason, "eligible");
});
