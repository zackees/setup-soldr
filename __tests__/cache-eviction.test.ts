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

test("thresholdsForPolicy returns 9.5/9.0 + 6h age floor for protect-foundations", () => {
  assert.deepEqual(thresholdsForPolicy("protect-foundations"), {
    triggerGb: 9.5,
    targetGb: 9,
    minAgeHoursBeforeDelete: 6,
  });
});

test("thresholdsForPolicy returns 7/6 + 2h age floor for aggressive (#352)", () => {
  assert.deepEqual(thresholdsForPolicy("aggressive"), {
    triggerGb: 7,
    targetGb: 6,
    minAgeHoursBeforeDelete: 2,
  });
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
    caches: [entry(1, "cook-delta-v2-foo", 500, 24)],
    usageGb: 9, // < 9.5 GB trigger
  });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, false);
  assert.equal(result.deletedCount, 0);
  assert.equal(deleted.length, 0);
});

test("evicts oldest non-foundation entries until under target", async () => {
  const caches = [
    entry(101, "cook-delta-v2-foo", 1024, 48), // oldest, evictable (>6h)
    entry(102, "zccache-Linux-X64-test-aaa", 1024, 36), // evictable
    entry(103, "cook-delta-v2-bar", 1024, 24), // evictable
    entry(104, "solo-toolchain-v2-xyz", 170, 12), // FOUNDATION — protected
    entry(105, "soldr-mini-darwin", 11, 12), // FOUNDATION
    entry(106, "setup-soldr-cargoregistry-v1-foo", 50, 12), // FOUNDATION
    entry(107, "cook-delta-v2-baz", 1024, 12), // evictable (>6h)
  ];
  // total = 3*1024 + 170 + 11 + 50 + 1024 ≈ 4.25 GB
  // But say usage is reported as 11 GB to force eviction.
  const { deps, deleted, log } = makeDeps({
    caches,
    usageGb: 11, // > 9.5 GB trigger
  });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  // Must evict oldest evictable first: 101 (48h), then 102 (36h)…
  // bytes start at 11 GB; need to drop to 9 GB target (delete 2 GB).
  // Each entry is 1024 MB = 1 GB. So 2 deletes get us to 9 GB.
  assert.deepEqual(deleted, [101, 102]);
  assert.equal(result.deletedCount, 2);
  // None of the foundation entries should be in the delete list.
  for (const protectedId of [104, 105, 106]) {
    assert.ok(!deleted.includes(protectedId), `entry ${protectedId} was foundation, should not be deleted`);
  }
  // log mentions eviction.
  assert.ok(log.some((l) => l.includes("evicting toward 9 GB")), `expected log line, got: ${log.join("\n")}`);
});

test("age floor protects fresh entries from self-eviction (#352)", async () => {
  // All non-foundation entries fresh (< 6h). Even though usage is over
  // trigger, NO eviction should happen because the age floor protects
  // them. This is the fix for #352 — protect this run's just-saved
  // cook/build caches from being deleted before the next CI cycle.
  const caches = [
    entry(201, "cook-base-v2-foo", 2000, 0.1), // age 6 minutes
    entry(202, "setup-soldr-buildcache-v2-bar", 300, 0.1),
    entry(203, "cook-delta-v2-baz", 1500, 1.5), // age 1.5h still < 6h
    entry(204, "solo-toolchain-v2-foo", 170, 1), // foundation, anyway
  ];
  const { deps, deleted, log } = makeDeps({ caches, usageGb: 10 });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  // Should attempt to evict (usage > trigger) but find ZERO eligible
  // entries because all non-foundation entries are < 6h old.
  assert.equal(result.deletedCount, 0, "no entries should be deleted — all fresh");
  assert.equal(deleted.length, 0);
  assert.ok(
    log.some((l) => l.includes("protected") && l.includes("younger than 6h")),
    `expected protected-by-age log line, got: ${log.join("\n")}`,
  );
});

test("404 from delete is tolerated (concurrent race)", async () => {
  const caches = [entry(1, "cook-delta-v2-foo", 1024, 24)];
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
    entry(1, "cook-delta-v2-foo", 1024, 24),
    entry(2, "cook-delta-v2-bar", 1024, 18),
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
