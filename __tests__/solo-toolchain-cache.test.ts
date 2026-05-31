// Tests for src/lib/solo-toolchain-cache.ts.
//
// Covers the pure pieces (key shape, hash determinism, libc detect,
// staging-copy) without exercising the actual @actions/cache network
// round trip — that's validated end-to-end by the demo workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSoloCacheKeys,
  detectLibc,
  hashStringArray,
  stageDiffForSave,
  applyStagedToLiveRoots,
  type RootMap,
} from "../src/lib/solo-toolchain-cache.js";
import type { SnapshotDiff, SnapshotEntry } from "../src/lib/toolchain-snapshot.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

test("hashStringArray is stable across input order", () => {
  assert.equal(
    hashStringArray(["rustfmt", "clippy", "rust-src"]),
    hashStringArray(["clippy", "rust-src", "rustfmt"]),
  );
});

test("hashStringArray returns 'none' for empty inputs", () => {
  assert.equal(hashStringArray([]), "none");
  assert.equal(hashStringArray(["", "  "]), "none");
});

test("hashStringArray is case-insensitive and trims", () => {
  assert.equal(hashStringArray(["RustFmt", "Clippy"]), hashStringArray(["rustfmt", "  clippy  "]));
});

test("buildSoloCacheKeys produces stable exact key with all parts", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    componentsHash: "deadbeef",
    targetsHash: "cafebabe",
    soldrVersion: "0.7.28",
  });
  assert.equal(
    keys.exact,
    "solo-toolchain-v2-linux-x64-glibc-rustc1.84.1-cdeadbeef-tcafebabe-soldr0.7.28",
  );
});

test("buildSoloCacheKeys restore-key ladder drops in the documented order", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    componentsHash: "ch",
    targetsHash: "th",
    soldrVersion: "1.0.0",
  });
  // 1) drop soldr version, 2) also drop targets, 3) also drop components
  assert.deepEqual(keys.fallbacks, [
    "solo-toolchain-v2-linux-x64-glibc-rustc1.84.1-cch-tth-soldr",
    "solo-toolchain-v2-linux-x64-glibc-rustc1.84.1-cch-t-soldr",
    "solo-toolchain-v2-linux-x64-glibc-rustc1.84.1-c-t-soldr",
  ]);
});

test("buildSoloCacheKeys never drops os/arch/libc/release", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "macos",
    runnerArch: "arm64",
    libc: "darwin",
    rustcRelease: "1.83.0",
    componentsHash: "a",
    targetsHash: "b",
    soldrVersion: "0.7.28",
  });
  for (const key of [keys.exact, ...keys.fallbacks]) {
    assert.ok(key.includes("-macos-"), `missing os in ${key}`);
    assert.ok(key.includes("-arm64-"), `missing arch in ${key}`);
    assert.ok(key.includes("-darwin-"), `missing libc in ${key}`);
    assert.ok(key.includes("-rustc1.83.0-"), `missing release in ${key}`);
  }
});

test("detectLibc returns one of the documented values for this host", () => {
  const v = detectLibc();
  assert.ok(["glibc", "musl", "darwin", "msvc", "unknown"].includes(v));
});

test("stageDiffForSave + applyStagedToLiveRoots round-trip", async () => {
  const liveA = mkTmp("solo-stage-toolchains-");
  const liveB = mkTmp("solo-stage-bin-");
  const stagingDir = mkTmp("solo-stage-area-");
  const liveARestored = mkTmp("solo-restore-toolchains-");
  const liveBRestored = mkTmp("solo-restore-bin-");
  try {
    // Populate live state.
    writeFile(liveA, "1.84.0/bin/rustc", "rustc-bytes");
    writeFile(liveA, "1.84.0/lib/libstd.so", "libstd-bytes");
    writeFile(liveB, "rustfmt", "rustfmt-bytes");

    const sourceMap: RootMap = {
      "rustup-toolchains": liveA,
      "cargo-bin": liveB,
    };

    // Build a synthetic diff that pretends these are the "added" inodes.
    const added: SnapshotEntry[] = [
      { root: liveA, relpath: "1.84.0", kind: "directory", size: 0 },
      { root: liveA, relpath: "1.84.0/bin", kind: "directory", size: 0 },
      { root: liveA, relpath: "1.84.0/bin/rustc", kind: "file", size: 11 },
      { root: liveA, relpath: "1.84.0/lib", kind: "directory", size: 0 },
      { root: liveA, relpath: "1.84.0/lib/libstd.so", kind: "file", size: 12 },
      { root: liveB, relpath: "rustfmt", kind: "file", size: 13 },
    ];
    const diff: SnapshotDiff = { added, removed: [], changed: [] };

    const stageResult = await stageDiffForSave(diff, sourceMap, stagingDir);
    assert.equal(stageResult.stagedFiles, 3);
    assert.equal(stageResult.missingFiles, 0);
    assert.ok(
      fs.existsSync(path.join(stagingDir, "rustup-toolchains/1.84.0/bin/rustc")),
      "rustc not staged",
    );
    assert.ok(
      fs.existsSync(path.join(stagingDir, "cargo-bin/rustfmt")),
      "rustfmt not staged",
    );

    // Apply to a different pair of live roots (simulating restore on a
    // different runner).
    const restoreMap: RootMap = {
      "rustup-toolchains": liveARestored,
      "cargo-bin": liveBRestored,
    };
    const applied = await applyStagedToLiveRoots(stagingDir, restoreMap);
    assert.equal(applied.appliedFiles, 3);
    assert.equal(
      fs.readFileSync(path.join(liveARestored, "1.84.0/bin/rustc"), "utf8"),
      "rustc-bytes",
    );
    assert.equal(
      fs.readFileSync(path.join(liveARestored, "1.84.0/lib/libstd.so"), "utf8"),
      "libstd-bytes",
    );
    assert.equal(
      fs.readFileSync(path.join(liveBRestored, "rustfmt"), "utf8"),
      "rustfmt-bytes",
    );
  } finally {
    rmDir(liveA);
    rmDir(liveB);
    rmDir(stagingDir);
    rmDir(liveARestored);
    rmDir(liveBRestored);
  }
});

test("stageDiffForSave silently skips entries whose root isn't in the map", async () => {
  const liveA = mkTmp("solo-strange-");
  const stagingDir = mkTmp("solo-strange-stage-");
  try {
    writeFile(liveA, "file", "x");
    const sourceMap: RootMap = {
      "rustup-toolchains": "/some/other/root",
      "cargo-bin": "/another/different/root",
    };
    const diff: SnapshotDiff = {
      added: [{ root: liveA, relpath: "file", kind: "file", size: 1 }],
      removed: [],
      changed: [],
    };
    const stageResult = await stageDiffForSave(diff, sourceMap, stagingDir);
    assert.equal(stageResult.stagedFiles, 0);
    assert.equal(stageResult.missingFiles, 0);
  } finally {
    rmDir(liveA);
    rmDir(stagingDir);
  }
});
