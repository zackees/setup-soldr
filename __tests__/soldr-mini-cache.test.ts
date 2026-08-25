// Tests for src/lib/soldr-mini-cache.ts.
//
// Pure-function coverage. The actual cache restore/save round trip is
// validated end-to-end by the demo workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMiniCacheKey, isEligibleForMiniCache, restoreMiniCache } from "../src/lib/soldr-mini-cache.js";

test("buildMiniCacheKey shape includes only the coarse dimensions", () => {
  const key = buildMiniCacheKey({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    soldrVersion: "0.7.28",
  });
  assert.equal(key, "soldr-mini-v2-linux-x64-glibc-v0.7.28");
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
  assert.equal(withV, "soldr-mini-v2-linux-x64-glibc-v0.7.28");
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

test("#475 soldr mini-cache rejects a matched zero-byte archive with a warning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr-mini-zero-"));
  const archivePath = path.join(root, "soldr.tar.zst");
  const warnings: string[] = [];
  try {
    const result = await restoreMiniCache({
      exactKey: "soldr-mini-exact",
      installDir: path.join(root, "install"),
      archivePath,
      longWindow: 27,
      debug: false,
      binaryPath: path.join(root, "install", "soldr"),
      expectedVersion: "0.9.9",
      log: () => {},
      warn: (message) => warnings.push(message),
      restoreCache: async (paths, key) => {
        fs.writeFileSync(paths[0]!, Buffer.alloc(0));
        return key;
      },
    });
    assert.deepEqual(result, { hit: false, matchedKey: "", archiveBytes: 0 });
    assert.ok(warnings.some((line) => line.includes("soldr-mini-exact") && line.includes("archive=0B")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#475 soldr mini-cache rejects a non-empty archive that extracts no payload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr-mini-empty-extract-"));
  const archivePath = path.join(root, "soldr.tar.zst");
  const warnings: string[] = [];
  try {
    const result = await restoreMiniCache({
      exactKey: "soldr-mini-truncated",
      installDir: path.join(root, "install"),
      archivePath,
      longWindow: 27,
      debug: false,
      binaryPath: path.join(root, "install", "soldr"),
      expectedVersion: "0.9.9",
      log: () => {},
      warn: (message) => warnings.push(message),
      restoreCache: async (paths, key) => {
        fs.writeFileSync(paths[0]!, Buffer.from([0x1f, 0x8b, 0x08]));
        return key;
      },
      decompress: async () => ({ archiveBytes: 3, inflatedBytes: 0, fileCount: 0 }),
      verifyBinary: async () => true,
    });
    assert.equal(result.hit, false);
    assert.equal(result.matchedKey, "");
    assert.ok(warnings.some((line) => line.includes("extracted_files=0")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#475 soldr mini-cache rejects a structurally non-empty payload with an unusable binary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr-mini-bad-binary-"));
  const archivePath = path.join(root, "soldr.tar.zst");
  const warnings: string[] = [];
  let verified = false;
  try {
    const result = await restoreMiniCache({
      exactKey: "soldr-mini-v2-linux-x64-glibc-v0.9.9",
      installDir: path.join(root, "install"),
      archivePath,
      binaryPath: path.join(root, "install", "soldr"),
      expectedVersion: "0.9.9",
      longWindow: 27,
      debug: false,
      log: () => {},
      warn: (message) => warnings.push(message),
      restoreCache: async (paths, key) => {
        fs.writeFileSync(paths[0]!, Buffer.from([0x1f, 0x8b, 0x08]));
        return key;
      },
      decompress: async () => ({ archiveBytes: 3, inflatedBytes: 10, fileCount: 1 }),
      verifyBinary: async (binaryPath, expectedVersion) => {
        verified = binaryPath.endsWith("soldr") && expectedVersion === "0.9.9";
        return false;
      },
    });
    assert.equal(verified, true);
    assert.equal(result.hit, false);
    assert.equal(result.matchedKey, "");
    assert.ok(warnings.some((line) => line.includes("missing, corrupt, or not version 0.9.9")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
