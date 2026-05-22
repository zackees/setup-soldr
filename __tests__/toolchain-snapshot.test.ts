// Tests for src/lib/toolchain-snapshot.ts.
//
// Verifies the diff logic against synthetic baseline / post-install
// filesystem fixtures. The wire shape these tests pin down is what a
// future cache-save step will tar — so getting "added" right matters
// more than the absolute size numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  walkSnapshot,
  diffSnapshots,
  diffStats,
  serializeManifest,
} from "../src/lib/toolchain-snapshot.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function rmDir(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test("walkSnapshot tolerates missing root and returns empty snapshot", async () => {
  const snap = await walkSnapshot([path.join(os.tmpdir(), "definitely-not-here-" + Date.now())]);
  assert.equal(snap.entries.size, 0);
});

test("walkSnapshot captures files, directories, and sizes under one root", async () => {
  const root = mkTmp("ts-snap-walk-");
  writeFile(root, "bin/rustup", "rustup-content");
  writeFile(root, "bin/cargo", "cargo-content-longer");
  writeFile(root, "lib/sub/deep.so", "x");
  try {
    const snap = await walkSnapshot([root]);
    const rels = new Set([...snap.entries.values()].map((e) => `${e.kind}:${e.relpath}`));
    assert.ok(rels.has("file:bin/rustup"));
    assert.ok(rels.has("file:bin/cargo"));
    assert.ok(rels.has("file:lib/sub/deep.so"));
    assert.ok(rels.has("directory:bin"));
    assert.ok(rels.has("directory:lib"));
    assert.ok(rels.has("directory:lib/sub"));

    const rustup = [...snap.entries.values()].find((e) => e.relpath === "bin/rustup");
    assert.equal(rustup?.size, "rustup-content".length);
  } finally {
    rmDir(root);
  }
});

test("diffSnapshots categorizes added / removed / changed correctly", async () => {
  const root = mkTmp("ts-snap-diff-");
  try {
    // Baseline: rustup + cargo exist, deep file with one size.
    writeFile(root, "bin/rustup", "rustup");
    writeFile(root, "bin/cargo", "cargo");
    writeFile(root, "toolchains/stable/lib/libstd.so", "libstd-baseline");
    const baseline = await walkSnapshot([root]);

    // Post-install: cargo got bigger (changed), libstd same (kept),
    // new component added, old `rustup` deleted (removed).
    fs.rmSync(path.join(root, "bin/rustup"));
    writeFile(root, "bin/cargo", "cargo-replaced-with-longer-content");
    writeFile(root, "toolchains/stable/lib/rustlib/clippy", "clippy-bin");
    const postInstall = await walkSnapshot([root]);

    const diff = diffSnapshots(baseline, postInstall);
    const addedRels = new Set(diff.added.map((e) => e.relpath));
    const removedRels = new Set(diff.removed.map((e) => e.relpath));
    const changedRels = new Set(diff.changed.map((c) => c.after.relpath));

    assert.ok(addedRels.has("toolchains/stable/lib/rustlib/clippy"));
    assert.ok(addedRels.has("toolchains/stable/lib/rustlib"));
    assert.ok(removedRels.has("bin/rustup"));
    assert.ok(changedRels.has("bin/cargo"));
    assert.ok(!addedRels.has("toolchains/stable/lib/libstd.so"));
    assert.ok(!removedRels.has("toolchains/stable/lib/libstd.so"));
  } finally {
    rmDir(root);
  }
});

test("diffStats aggregates file counts and added bytes", async () => {
  const root = mkTmp("ts-snap-stats-");
  try {
    writeFile(root, "bin/existing", "existing");
    const baseline = await walkSnapshot([root]);
    writeFile(root, "bin/new-a", "a".repeat(1000));
    writeFile(root, "bin/new-b", "b".repeat(2500));
    writeFile(root, "bin/existing", "modified-existing");
    const post = await walkSnapshot([root]);

    const diff = diffSnapshots(baseline, post);
    const stats = diffStats(diff);
    assert.equal(stats.addedFiles, 2);
    assert.equal(stats.addedBytes, 1000 + 2500);
    assert.equal(stats.changedFiles, 1);
    assert.equal(stats.removedFiles, 0);
  } finally {
    rmDir(root);
  }
});

test("walkSnapshot keeps roots independent — same relpath under two roots = two entries", async () => {
  const rootA = mkTmp("ts-snap-multi-a-");
  const rootB = mkTmp("ts-snap-multi-b-");
  try {
    writeFile(rootA, "bin/cargo", "cargo-from-A");
    writeFile(rootB, "bin/cargo", "cargo-from-B");
    const snap = await walkSnapshot([rootA, rootB]);
    const fileEntries = [...snap.entries.values()].filter(
      (e) => e.relpath === "bin/cargo" && e.kind === "file",
    );
    assert.equal(fileEntries.length, 2);
    assert.notEqual(fileEntries[0]?.root, fileEntries[1]?.root);
  } finally {
    rmDir(rootA);
    rmDir(rootB);
  }
});

test("serializeManifest produces stable, sorted JSON", async () => {
  const root = mkTmp("ts-snap-manifest-");
  try {
    writeFile(root, "z-last", "z");
    writeFile(root, "a-first", "a");
    writeFile(root, "m-middle", "m");
    const baseline = await walkSnapshot([root]);
    writeFile(root, "y-new", "y");
    writeFile(root, "b-new", "b");
    const post = await walkSnapshot([root]);

    const diff = diffSnapshots(baseline, post);
    const stats = diffStats(diff);
    const json1 = serializeManifest(diff, stats);
    const json2 = serializeManifest(diff, stats);
    assert.equal(json1, json2);

    const parsed = JSON.parse(json1) as { added: { relpath: string }[] };
    const addedRels = parsed.added.map((e) => e.relpath);
    const sorted = [...addedRels].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(addedRels, sorted);
  } finally {
    rmDir(root);
  }
});

test("no-op case: baseline and post identical → empty diff (CLAUDE.md no-op invariant)", async () => {
  const root = mkTmp("ts-snap-noop-");
  try {
    writeFile(root, "bin/rustup", "preinstalled-rustup");
    writeFile(root, "toolchains/stable-x86_64-unknown-linux-gnu/bin/rustc", "preinstalled-rustc");
    const baseline = await walkSnapshot([root]);
    const post = await walkSnapshot([root]);
    const diff = diffSnapshots(baseline, post);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.changed.length, 0);
  } finally {
    rmDir(root);
  }
});

test("symlink retargeting registers as a change, not an add+remove", async () => {
  if (process.platform === "win32") {
    // Symlink creation on Windows needs admin or developer mode.
    // Skip rather than skew CI on locked-down runners.
    return;
  }
  const root = mkTmp("ts-snap-symlink-");
  try {
    writeFile(root, "bin/target-a", "a");
    writeFile(root, "bin/target-b", "b");
    fs.symlinkSync("target-a", path.join(root, "bin/link"));
    const baseline = await walkSnapshot([root]);

    fs.rmSync(path.join(root, "bin/link"));
    fs.symlinkSync("target-b", path.join(root, "bin/link"));
    const post = await walkSnapshot([root]);

    const diff = diffSnapshots(baseline, post);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]?.before.linkTarget, "target-a");
    assert.equal(diff.changed[0]?.after.linkTarget, "target-b");
  } finally {
    rmDir(root);
  }
});
