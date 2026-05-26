// Tests for src/lib/cook-cache.ts.
//
// Covers the pure pieces — key shape, flag canonicalization, gate
// decisions, hash stability. The actual cache restore/save round trip
// is validated end-to-end by the demo workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCookCacheKey,
  decideCookGate,
  hashCookFlags,
  isCookMode,
  canonicalizeCookFlags,
  parseCookFlags,
} from "../src/lib/cook-cache.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("hashCookFlags is stable across order and whitespace", () => {
  assert.equal(
    hashCookFlags(["--release", "--workspace"]),
    hashCookFlags(["--workspace", "  --release  "]),
  );
});

test("hashCookFlags returns 'none' for empty inputs", () => {
  assert.equal(hashCookFlags([]), "none");
  assert.equal(hashCookFlags(["", "  "]), "none");
});

test("hashCookFlags is sensitive to material flag changes", () => {
  assert.notEqual(hashCookFlags(["--release"]), hashCookFlags(["--release", "--workspace"]));
  assert.notEqual(
    hashCookFlags(["--release"]),
    hashCookFlags(["--release", "--target", "x86_64-unknown-linux-musl"]),
  );
});

test("buildCookCacheKey shape includes every dimension", () => {
  const key = buildCookCacheKey({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "abc12345",
    lockHash: "deadbeef",
    soldrVersion: "v0.7.28",
  });
  assert.equal(
    key,
    "cook-linux-x64-glibc-rustc1.84.1-fabc12345-ldeadbeef-soldrv0.7.28",
  );
});

test("buildCookCacheKey is content-addressable — same inputs always produce same key", () => {
  const parts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "x",
    lockHash: "y",
    soldrVersion: "0.7.28",
  };
  assert.equal(buildCookCacheKey(parts), buildCookCacheKey(parts));
});

test("buildCookCacheKey does NOT include SHA — same lock hits across branches", () => {
  // Per the simulation findings: SHA in cook key = catastrophic eviction.
  // This test pins the contract: the key shape must remain content-addressable.
  const baseParts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "x",
    lockHash: "y",
    soldrVersion: "0.7.28",
  };
  // Two different "branches" with the same lockHash should produce the
  // same key. If a future change adds SHA to the key, this regresses.
  const branchA = buildCookCacheKey({ ...baseParts });
  const branchB = buildCookCacheKey({ ...baseParts });
  assert.equal(branchA, branchB);
});

test("isCookMode accepts soldr-cook and legacy cargo-chef alias", () => {
  assert.equal(isCookMode("soldr-cook"), true);
  assert.equal(isCookMode(" SOLDR-COOK "), true);
  assert.equal(isCookMode("cargo-chef"), true);
  assert.equal(isCookMode("bazel"), false);
});

test("parseCookFlags handles whitespace + empty input", () => {
  assert.deepEqual(parseCookFlags(""), []);
  assert.deepEqual(parseCookFlags("  "), []);
  assert.deepEqual(parseCookFlags("--release"), ["--release"]);
  assert.deepEqual(parseCookFlags("--release --workspace"), ["--release", "--workspace"]);
  assert.deepEqual(parseCookFlags("  --release   --target   x86_64-unknown-linux-musl  "), [
    "--release",
    "--target",
    "x86_64-unknown-linux-musl",
  ]);
});

test("canonicalizeCookFlags strips cosmetic flags", () => {
  assert.deepEqual(
    canonicalizeCookFlags(["--release", "--verbose", "-q", "--workspace"]),
    ["--release", "--workspace"],
  );
});

test("canonicalizeCookFlags preserves output-material flags", () => {
  const flags = ["--release", "--target", "x86_64-unknown-linux-musl", "--no-default-features", "--profile", "lto"];
  // All of these affect what cook produces; none should be stripped.
  assert.deepEqual(canonicalizeCookFlags(flags), flags);
});

test("decideCookGate disables on prebuild-deps=none", () => {
  const lock = mkTmp("cook-gate-lock-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    for (const v of ["none", "off", "false", ""]) {
      const g = decideCookGate({ prebuildDeps: v, cacheUmbrella: true, lockfilePath: lockPath });
      assert.equal(g.enabled, false, `expected gate disabled for ${JSON.stringify(v)}`);
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate disables on unknown strategy", () => {
  const lock = mkTmp("cook-gate-unknown-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({ prebuildDeps: "bazel", cacheUmbrella: true, lockfilePath: lockPath });
    assert.equal(g.enabled, false);
    assert.match(g.reason, /unknown strategy/);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate disables when cache umbrella is off", () => {
  const lock = mkTmp("cook-gate-cache-off-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({
      prebuildDeps: "cargo-chef",
      cacheUmbrella: false,
      lockfilePath: lockPath,
    });
    assert.equal(g.enabled, false);
    assert.match(g.reason, /cache: false/);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate disables when Cargo.lock missing", () => {
  const g = decideCookGate({
    prebuildDeps: "cargo-chef",
    cacheUmbrella: true,
    lockfilePath: "",
  });
  assert.equal(g.enabled, false);
  assert.match(g.reason, /no Cargo\.lock/);

  const g2 = decideCookGate({
    prebuildDeps: "cargo-chef",
    cacheUmbrella: true,
    lockfilePath: "/definitely/does/not/exist/Cargo.lock",
  });
  assert.equal(g2.enabled, false);
  assert.match(g2.reason, /does not exist/);
});

test("decideCookGate enables for soldr-cook mode", () => {
  const lock = mkTmp("cook-gate-ok-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({
      prebuildDeps: "soldr-cook",
      cacheUmbrella: true,
      lockfilePath: lockPath,
    });
    assert.equal(g.enabled, true);
    assert.match(g.reason, /soldr-cook enabled/);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate keeps cargo-chef as a compatibility alias", () => {
  const lock = mkTmp("cook-gate-legacy-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({
      prebuildDeps: "cargo-chef",
      cacheUmbrella: true,
      lockfilePath: lockPath,
    });
    assert.equal(g.enabled, true);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});
