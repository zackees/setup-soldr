// Tests for src/lib/source-mtime-snapshot.ts.
//
// Critical safety property: replay only applies an mtime when the
// CURRENT file content is byte-identical to the snapshot. If a file
// was edited between snapshot and replay (or never existed at all),
// its mtime must be left alone so Cargo correctly rebuilds it.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  snapshotSourceMtimes,
  replaySourceMtimes,
  writeSnapshotFile,
  readSnapshotFile,
  SNAPSHOT_FILENAME,
} from "../src/lib/source-mtime-snapshot.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitInit(root: string): void {
  const cmds: string[][] = [
    ["init", "-q"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["config", "commit.gpgsign", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init", "--no-gpg-sign"],
  ];
  for (const args of cmds) {
    const r = spawnSync("git", args, { cwd: root });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    }
  }
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function makeWorkspace(files: Record<string, string>): string {
  const root = mkTmp("snapshot-test-");
  for (const [rel, content] of Object.entries(files)) {
    writeFile(root, rel, content);
  }
  gitInit(root);
  return root;
}

test("snapshot records mtime, size, hash for tracked Rust files", async () => {
  const ws = makeWorkspace({
    "Cargo.toml": '[package]\nname="x"\nversion="0.1.0"\n',
    "src/main.rs": "fn main() {}\n",
    "README.md": "ignored\n", // not a Rust input
  });
  const r = await snapshotSourceMtimes({ workspace: ws });
  assert.ok(r.scanned >= 2, `expected scanned>=2, got ${r.scanned}`);
  assert.ok("Cargo.toml" in r.snapshot.files);
  assert.ok("src/main.rs" in r.snapshot.files);
  assert.ok(!("README.md" in r.snapshot.files), "README.md should not be tracked as a build input");
  const e = r.snapshot.files["src/main.rs"];
  assert.ok(e !== undefined);
  assert.equal(e.size, fs.statSync(path.join(ws, "src/main.rs")).size);
  assert.ok(e.hash.length === 32);
});

test("replay restores mtime when content matches", async () => {
  const ws = makeWorkspace({
    "Cargo.toml": '[package]\nname="x"\nversion="0.1.0"\n',
    "src/main.rs": "fn main() {}\n",
  });
  const r = await snapshotSourceMtimes({ workspace: ws });
  // Rewrite mtimes to "now" to simulate fresh actions/checkout.
  const newer = Date.now() / 1000 + 100;
  for (const rel of Object.keys(r.snapshot.files)) {
    fs.utimesSync(path.join(ws, rel), newer, newer);
  }
  const beforeReplay = fs.statSync(path.join(ws, "src/main.rs")).mtimeMs;
  const rr = await replaySourceMtimes({ workspace: ws, snapshot: r.snapshot });
  assert.equal(rr.applied, Object.keys(r.snapshot.files).length, "every matched file should get its mtime restored");
  assert.equal(rr.skipped_modified, 0);
  assert.equal(rr.skipped_size_mismatch, 0);
  const afterReplay = fs.statSync(path.join(ws, "src/main.rs")).mtimeMs;
  assert.ok(afterReplay < beforeReplay, "mtime should be older after replay");
});

test("replay SKIPS files whose content changed (safety net)", async () => {
  const ws = makeWorkspace({
    "Cargo.toml": '[package]\nname="x"\nversion="0.1.0"\n',
    "src/main.rs": "fn main() {}\n",
  });
  const r = await snapshotSourceMtimes({ workspace: ws });
  // Modify src/main.rs CONTENT — different bytes, different hash.
  fs.writeFileSync(path.join(ws, "src/main.rs"), "fn main() { let x = 1; }\n", "utf8");
  const newer = Date.now() / 1000 + 100;
  fs.utimesSync(path.join(ws, "src/main.rs"), newer, newer);
  fs.utimesSync(path.join(ws, "Cargo.toml"), newer, newer);
  const mtimeBeforeReplay = fs.statSync(path.join(ws, "src/main.rs")).mtimeMs;
  const rr = await replaySourceMtimes({ workspace: ws, snapshot: r.snapshot });
  // Cargo.toml unchanged → applied. src/main.rs changed → skipped.
  assert.ok(rr.applied >= 1, "Cargo.toml should still get its mtime restored");
  assert.equal(
    rr.skipped_modified + rr.skipped_size_mismatch,
    1,
    "exactly one file should be flagged as modified (src/main.rs)",
  );
  const mtimeAfterReplay = fs.statSync(path.join(ws, "src/main.rs")).mtimeMs;
  assert.equal(
    Math.floor(mtimeAfterReplay),
    Math.floor(mtimeBeforeReplay),
    "modified file's mtime must NOT be overwritten",
  );
});

test("replay SKIPS files that no longer exist", async () => {
  const ws = makeWorkspace({
    "Cargo.toml": '[package]\nname="x"\nversion="0.1.0"\n',
    "src/main.rs": "fn main() {}\n",
  });
  const r = await snapshotSourceMtimes({ workspace: ws });
  fs.rmSync(path.join(ws, "src/main.rs"));
  const rr = await replaySourceMtimes({ workspace: ws, snapshot: r.snapshot });
  assert.ok(rr.skipped_missing >= 1, "deleted file should be reported as missing");
});

test("snapshot returns empty for non-git workspace", async () => {
  const ws = mkTmp("snapshot-no-git-");
  fs.writeFileSync(path.join(ws, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\n', "utf8");
  const r = await snapshotSourceMtimes({ workspace: ws });
  assert.equal(r.scanned, 0);
  assert.equal(Object.keys(r.snapshot.files).length, 0);
});

test("writeSnapshotFile / readSnapshotFile roundtrip", () => {
  const tmp = mkTmp("snapshot-rw-");
  const filePath = path.join(tmp, SNAPSHOT_FILENAME);
  const snap = {
    version: 1 as const,
    snapshot_at_ms: 1700000000000,
    workspace: "/tmp/test",
    files: {
      "src/main.rs": { mtime_ms: 1234567890123, size: 42, hash: "deadbeefcafef00d11223344556677ab" },
    },
  };
  writeSnapshotFile(snap, filePath);
  const out = readSnapshotFile(filePath);
  assert.deepEqual(out, snap);
});

test("readSnapshotFile returns null for missing or malformed", () => {
  const tmp = mkTmp("snapshot-bad-");
  assert.equal(readSnapshotFile(path.join(tmp, "nope.json")), null);
  fs.writeFileSync(path.join(tmp, "bad.json"), "{not json", "utf8");
  assert.equal(readSnapshotFile(path.join(tmp, "bad.json")), null);
  fs.writeFileSync(path.join(tmp, "v0.json"), '{"version":0,"files":{}}', "utf8");
  assert.equal(readSnapshotFile(path.join(tmp, "v0.json")), null);
});
