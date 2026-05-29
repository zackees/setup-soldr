// Tests for the #240 isolated-build-cache seed: copy only the reusable
// content-addressed zccache artifact store into an isolated SOLDR_CACHE_DIR,
// never live daemon state.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseIsolatedSeedTargets,
  seedIsolatedBuildCache,
  shouldSeedBuildCacheEntry,
} from "../src/lib/seed-isolated-cache.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("#240 parseIsolatedSeedTargets: splits on commas and newlines", () => {
  assert.deepEqual(parseIsolatedSeedTargets(""), []);
  assert.deepEqual(parseIsolatedSeedTargets("/a"), ["/a"]);
  assert.deepEqual(parseIsolatedSeedTargets("/a, /b\n/c"), ["/a", "/b", "/c"]);
});

test("#240 shouldSeedBuildCacheEntry: keeps artifacts + replay metadata, drops live/diagnostic", () => {
  // Kept.
  assert.equal(shouldSeedBuildCacheEntry("zccache/artifacts/abc123"), true);
  assert.equal(shouldSeedBuildCacheEntry("zccache/artifacts/compile.stderr"), true);
  assert.equal(shouldSeedBuildCacheEntry("zccache/private/sess-1/artifacts/x.out"), true);
  assert.equal(shouldSeedBuildCacheEntry("zccache/index.bin"), true);
  assert.equal(shouldSeedBuildCacheEntry("zccache/private/sess-1/state/index.bin"), true);
  // Dropped.
  assert.equal(shouldSeedBuildCacheEntry("zccache/logs/last-session.jsonl"), false);
  assert.equal(shouldSeedBuildCacheEntry("zccache/session.jsonl"), false);
  assert.equal(shouldSeedBuildCacheEntry("zccache/daemon.sock"), false);
  assert.equal(shouldSeedBuildCacheEntry("zccache/daemon.pid"), false);
  assert.equal(shouldSeedBuildCacheEntry("zccache/build.lock"), false);
  assert.equal(shouldSeedBuildCacheEntry("zccache/state/daemon.stderr"), false);
});

test("#240 seedIsolatedBuildCache: copies only the reusable store into <root>/cache/zccache", () => {
  const root = mkTmp("seed-isolated-");
  try {
    const src = path.join(root, "src-soldr", "cache", "zccache");
    fs.mkdirSync(path.join(src, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(src, "private", "sess-1", "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(src, "logs"), { recursive: true });
    fs.mkdirSync(path.join(src, "state"), { recursive: true });
    fs.writeFileSync(path.join(src, "artifacts", "hash-a"), Buffer.alloc(10));
    fs.writeFileSync(path.join(src, "artifacts", "compile.stderr"), Buffer.alloc(3));
    fs.writeFileSync(path.join(src, "private", "sess-1", "artifacts", "hash-b"), Buffer.alloc(20));
    fs.writeFileSync(path.join(src, "index.bin"), Buffer.alloc(5));
    // Live / diagnostic — must NOT be seeded.
    fs.writeFileSync(path.join(src, "logs", "last-session.jsonl"), Buffer.alloc(100));
    fs.writeFileSync(path.join(src, "daemon.sock"), Buffer.alloc(1));
    fs.writeFileSync(path.join(src, "build.lock"), Buffer.alloc(1));
    fs.writeFileSync(path.join(src, "state", "daemon.stderr"), Buffer.alloc(7));

    const isolated = path.join(root, "isolated-soldr");
    const result = seedIsolatedBuildCache({
      sourceZccacheDir: src,
      targetSoldrRoots: [isolated],
    });

    assert.equal(result.seeded, true);
    assert.equal(result.filesCopied, 4);
    const dest = path.join(isolated, "cache", "zccache");
    const exists = (rel: string): boolean => fs.existsSync(path.join(dest, rel));
    assert.ok(exists("artifacts/hash-a"));
    assert.ok(exists("artifacts/compile.stderr"));
    assert.ok(exists("private/sess-1/artifacts/hash-b"));
    assert.ok(exists("index.bin"));
    // Not seeded.
    assert.equal(exists("logs/last-session.jsonl"), false);
    assert.equal(exists("daemon.sock"), false);
    assert.equal(exists("build.lock"), false);
    assert.equal(exists("state/daemon.stderr"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#240 seedIsolatedBuildCache: no-op when source missing or no targets", () => {
  const root = mkTmp("seed-isolated-empty-");
  try {
    assert.equal(
      seedIsolatedBuildCache({ sourceZccacheDir: path.join(root, "nope"), targetSoldrRoots: ["/x"] }).seeded,
      false,
    );
    assert.equal(
      seedIsolatedBuildCache({ sourceZccacheDir: root, targetSoldrRoots: [] }).skippedReason,
      "no-targets",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
