import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evictIfOverBudget,
  thresholdsForPolicy,
  FOUNDATION_PREFIXES,
  type CacheEntry,
  type EvictDeps,
} from "../src/lib/cache-eviction.js";

const GB = 1024 * 1024 * 1024;

function makeDeps(opts: {
  caches: CacheEntry[];
  usageGb: number;
  deletions?: number[];
}): { deps: EvictDeps; deleted: number[]; log: string[] } {
  const log: string[] = [];
  const deleted: number[] = opts.deletions ?? [];
  const deps: EvictDeps = {
    owner: "test-owner",
    repo: "test-repo",
    token: "fake-token",
    log: (msg) => log.push(msg),
    listCaches: async () => opts.caches,
    getUsageBytes: async () => opts.usageGb * GB,
    deleteCacheById: async (id) => {
      deleted.push(id);
    },
  };
  return { deps, deleted, log };
}

function entry(id: number, key: string, sizeMB: number, ageHours: number): CacheEntry {
  return {
    id,
    key,
    size_in_bytes: sizeMB * 1024 * 1024,
    created_at: new Date(Date.now() - ageHours * 3600 * 1000).toISOString(),
  };
}

test("thresholdsForPolicy returns null for disabled", () => {
  assert.equal(thresholdsForPolicy("disabled"), null);
});

test("thresholdsForPolicy returns 8/7 for protect-foundations", () => {
  assert.deepEqual(thresholdsForPolicy("protect-foundations"), { triggerGb: 8, targetGb: 7 });
});

test("thresholdsForPolicy returns 6/5 for aggressive", () => {
  assert.deepEqual(thresholdsForPolicy("aggressive"), { triggerGb: 6, targetGb: 5 });
});

test("disabled policy never fires", async () => {
  const { deps, deleted } = makeDeps({ caches: [], usageGb: 20 });
  const result = await evictIfOverBudget("disabled", deps);
  assert.equal(result.fired, false);
  assert.equal(result.reason, "policy=disabled");
  assert.equal(deleted.length, 0);
});

test("under trigger threshold is no-op", async () => {
  const { deps, deleted } = makeDeps({
    caches: [entry(1, "cook-delta-v2-foo", 500, 1)],
    usageGb: 7,
  });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, false);
  assert.equal(result.deletedCount, 0);
  assert.equal(deleted.length, 0);
});

test("evicts oldest non-foundation entries until under target", async () => {
  const caches = [
    entry(101, "cook-delta-v2-foo", 1024, 10), // oldest, evictable
    entry(102, "zccache-Linux-X64-test-aaa", 1024, 8), // evictable
    entry(103, "cook-delta-v2-bar", 1024, 5), // evictable
    entry(104, "solo-toolchain-v2-xyz", 170, 4), // FOUNDATION — protected
    entry(105, "soldr-mini-darwin", 11, 3), // FOUNDATION
    entry(106, "setup-soldr-cargoregistry-v1-foo", 50, 2), // FOUNDATION
    entry(107, "cook-delta-v2-baz", 1024, 1), // newest evictable
  ];
  // total = 3*1024 + 170 + 11 + 50 + 1024 ≈ 4MB foundations + 4096MB evictable ≈ 4.25 GB
  // But say usage is reported as 10 GB to force eviction.
  const { deps, deleted, log } = makeDeps({
    caches,
    usageGb: 10, // > 8 GB trigger
  });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  // Must evict oldest evictable first: 101 (10h), then 102 (8h), then 103 (5h)…
  // bytes start at 10 GB; need to drop to 7 GB (delete 3 GB).
  // Each entry is 1024 MB = 1 GB. So 3 deletes get us to 7 GB.
  assert.deepEqual(deleted, [101, 102, 103]);
  assert.equal(result.deletedCount, 3);
  // None of the foundation entries should be in the delete list.
  for (const protectedId of [104, 105, 106]) {
    assert.ok(!deleted.includes(protectedId), `entry ${protectedId} was foundation, should not be deleted`);
  }
  // log mentions eviction.
  assert.ok(log.some((l) => l.includes("evicting toward 7 GB")), `expected log line, got: ${log.join("\n")}`);
});

test("404 from delete is tolerated (concurrent race)", async () => {
  const caches = [entry(1, "cook-delta-v2-foo", 1024, 5)];
  const log: string[] = [];
  const deps: EvictDeps = {
    owner: "x",
    repo: "y",
    token: "z",
    log: (m) => log.push(m),
    listCaches: async () => caches,
    getUsageBytes: async () => 10 * GB,
    deleteCacheById: async () => {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    },
  };
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  assert.equal(result.deletedCount, 0); // 404 = treated as already-deleted
});

test("403 permission denied logs once and stops", async () => {
  const caches = [
    entry(1, "cook-delta-v2-foo", 1024, 5),
    entry(2, "cook-delta-v2-bar", 1024, 4),
  ];
  let attempts = 0;
  const log: string[] = [];
  const deps: EvictDeps = {
    owner: "x",
    repo: "y",
    token: "z",
    log: (m) => log.push(m),
    listCaches: async () => caches,
    getUsageBytes: async () => 10 * GB,
    deleteCacheById: async () => {
      attempts += 1;
      const err = new Error("forbidden") as Error & { status?: number };
      err.status = 403;
      throw err;
    },
  };
  await evictIfOverBudget("protect-foundations", deps);
  // First attempt logs the permission warning; subsequent ones should be skipped.
  assert.equal(attempts, 1, "should stop trying after 403");
  assert.ok(
    log.some((l) => l.includes("permission denied")),
    "should log a clear permission-denied message",
  );
});

test("entries matching ANY foundation prefix are protected", () => {
  for (const key of [
    "solo-toolchain-v2-linux-x64-glibc-rustc1.94.1-cnone-tnone-soldrv0.7.51",
    "soldr-mini-linux-x64-glibc-v0.7.51",
    "setup-soldr-v4-linux-unknown-abc-def",
    "setup-soldr-cargoregistry-v1-linux-unknown-abc",
  ]) {
    assert.ok(
      FOUNDATION_PREFIXES.some((p) => key.startsWith(p)),
      `${key} should be classified as foundation`,
    );
  }
});

test("entries NOT matching foundation prefix are evictable", () => {
  for (const key of [
    "cook-delta-v2-linux-x64-glibc-rustc1.94.1-fnone-l...",
    "cook-base-v2-linux-x64-glibc-rustc1.94.1-...",
    "setup-soldr-buildcache-v2-linux-unknown-abc",
    "zccache-Linux-X64-test-foo",
    "cargo-target-Linux-X64-bench-abc",
  ]) {
    assert.ok(
      !FOUNDATION_PREFIXES.some((p) => key.startsWith(p)),
      `${key} should NOT be classified as foundation`,
    );
  }
});
