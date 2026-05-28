import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { detectCompressMagic, planTarPayload } from "../src/lib/cache-compress.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("detectCompressMagic identifies zstd by magic bytes", async () => {
  const root = mkTmp("magic-zstd-");
  try {
    const file = path.join(root, "archive.tar.zst");
    const buf = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]);
    fs.writeFileSync(file, buf);
    assert.equal(await detectCompressMagic(file), "zstd");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectCompressMagic identifies gzip by magic bytes", async () => {
  const root = mkTmp("magic-gzip-");
  try {
    const file = path.join(root, "archive.tar.gz");
    const buf = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    fs.writeFileSync(file, buf);
    assert.equal(await detectCompressMagic(file), "gzip");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectCompressMagic returns unknown for unrelated content", async () => {
  const root = mkTmp("magic-unknown-");
  try {
    const file = path.join(root, "archive.txt");
    fs.writeFileSync(file, "Hello, world!");
    assert.equal(await detectCompressMagic(file), "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectCompressMagic returns unknown for missing file", async () => {
  assert.equal(await detectCompressMagic("/no/such/file.tar.zst"), "unknown");
});

test("detectCompressMagic returns unknown for empty file", async () => {
  const root = mkTmp("magic-empty-");
  try {
    const file = path.join(root, "empty");
    fs.writeFileSync(file, "");
    assert.equal(await detectCompressMagic(file), "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectCompressMagic handles short gzip-like prefix", async () => {
  const root = mkTmp("magic-short-");
  try {
    const file = path.join(root, "short");
    fs.writeFileSync(file, Buffer.from([0x1f, 0x8b]));
    assert.equal(await detectCompressMagic(file), "gzip");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planTarPayload filters transient files and reports largest payload entries", async () => {
  const root = mkTmp("payload-plan-");
  try {
    const cache = path.join(root, "cache");
    const nested = path.join(cache, "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(cache, "large.bin"), Buffer.alloc(10));
    fs.writeFileSync(path.join(nested, "small.txt"), Buffer.alloc(5));
    fs.writeFileSync(path.join(cache, "zccache.sock"), "not really a socket");
    fs.writeFileSync(path.join(cache, "worker.pid"), "123");
    fs.writeFileSync(path.join(cache, "build.lock"), "");
    fs.writeFileSync(path.join(cache, "old.tar.zst"), Buffer.alloc(100));
    fs.writeFileSync(path.join(cache, ".package-cache"), "");

    const plan = await planTarPayload({ parent: root, inputBasenames: ["cache"], topN: 2 });

    assert.equal(plan.bytes, 15);
    assert.equal(plan.files, 2);
    assert.deepEqual(plan.manifestEntries.sort(), ["cache/large.bin", "cache/nested/small.txt"]);
    assert.deepEqual(plan.topFiles.map((entry) => entry.path), ["cache/large.bin", "cache/nested/small.txt"]);
    assert.deepEqual(plan.topSubtrees.map((entry) => [entry.path, entry.bytes, entry.files]), [
      ["cache", 10, 1],
      ["cache/nested", 5, 1],
    ]);
    assert.equal(plan.topDirectories[0]?.path, "cache");
    assert.equal(plan.topDirectories[0]?.bytes, 15);
    const skipped = new Map(plan.skipped.map((entry) => [entry.reason, entry.count]));
    assert.equal(skipped.get("transient-socket-path"), 1);
    assert.equal(skipped.get("transient-pid-file"), 1);
    assert.equal(skipped.get("transient-lock-file"), 1);
    assert.equal(skipped.get("archive-file"), 1);
    assert.equal(skipped.get("transient-cargo-mutex"), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planTarPayload excludes zccache diagnostic logs from cache saves", async () => {
  const root = mkTmp("payload-logs-");
  try {
    const cache = path.join(root, "zccache");
    fs.mkdirSync(path.join(cache, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(cache, "logs", "archive", "no-session"), { recursive: true });
    fs.writeFileSync(path.join(cache, "artifacts", "keep.bin"), Buffer.alloc(7));
    fs.writeFileSync(path.join(cache, "logs", "last-session.jsonl"), Buffer.alloc(79 * 1024));
    fs.writeFileSync(path.join(cache, "logs", "archive", "no-session", "last-session.jsonl"), Buffer.alloc(79 * 1024));
    fs.writeFileSync(path.join(cache, "logs", "last-session-stats.json"), "{}");

    const plan = await planTarPayload({ parent: root, inputBasenames: ["zccache"], topN: 5 });

    assert.equal(plan.bytes, 7);
    assert.equal(plan.files, 1);
    assert.deepEqual(plan.manifestEntries, ["zccache/artifacts/keep.bin"]);
    const skipped = new Map(plan.skipped.map((entry) => [entry.reason, entry]));
    assert.equal(skipped.get("diagnostic-log-dir")?.count, 1);
    assert.deepEqual(skipped.get("diagnostic-log-dir")?.samples, ["zccache/logs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planTarPayload zccache build-cache profile keeps private artifacts, trims only diagnostics (#398)", async () => {
  const root = mkTmp("payload-zccache-private-");
  try {
    const cache = path.join(root, "zccache");
    const privateSession = path.join(cache, "private", "soldr-dev-123");
    fs.mkdirSync(path.join(cache, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(privateSession, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(privateSession, "state"), { recursive: true });
    fs.writeFileSync(path.join(cache, "artifacts", "public-hash"), Buffer.alloc(11));
    fs.writeFileSync(path.join(cache, "index.bin"), Buffer.alloc(13));
    fs.writeFileSync(path.join(privateSession, "artifacts", "private-hash"), Buffer.alloc(101));
    fs.writeFileSync(path.join(privateSession, "state", "index.bin"), Buffer.alloc(17));
    fs.writeFileSync(path.join(privateSession, "state", "debug.txt"), Buffer.alloc(19));
    fs.writeFileSync(path.join(cache, "last-session.jsonl"), Buffer.alloc(23));

    const plan = await planTarPayload({
      parent: root,
      inputBasenames: ["zccache"],
      topN: 5,
      profile: "zccache-build-cache",
    });

    // #398: private/<session>/artifacts is the reusable zccache store — it MUST
    // be kept (excluding it produced restored-but-0-hit build caches). Only
    // diagnostic logs (debug.txt, *.jsonl) are trimmed.
    assert.equal(plan.bytes, 142);
    assert.equal(plan.files, 4);
    assert.deepEqual(plan.manifestEntries.sort(), [
      "zccache/artifacts/public-hash",
      "zccache/index.bin",
      "zccache/private/soldr-dev-123/artifacts/private-hash",
      "zccache/private/soldr-dev-123/state/index.bin",
    ]);
    assert.deepEqual(plan.topSubtrees.map((entry) => [entry.path, entry.bytes, entry.files]), [
      ["zccache/private/soldr-dev-123", 118, 2],
      ["zccache", 13, 1],
      ["zccache/artifacts", 11, 1],
    ]);
    const skipped = new Map(plan.skipped.map((entry) => [entry.reason, entry]));
    assert.equal(skipped.get("zccache-private-artifacts"), undefined);
    assert.equal(skipped.get("diagnostic-log-file")?.count, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planTarPayload archives symlink entries without following external targets", async () => {
  const root = mkTmp("payload-symlink-");
  try {
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache, { recursive: true });
    const outside = path.join(root, "outside.bin");
    fs.writeFileSync(outside, Buffer.alloc(1234));
    const link = path.join(cache, "outside-link");
    try {
      fs.symlinkSync(outside, link, "file");
    } catch {
      return;
    }

    const plan = await planTarPayload({ parent: root, inputBasenames: ["cache"], topN: 5 });

    assert.equal(plan.bytes, 0);
    assert.equal(plan.files, 0);
    assert.equal(plan.symlinks, 1);
    assert.deepEqual(plan.manifestEntries, ["cache/outside-link"]);
    assert.deepEqual(plan.topFiles, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planTarPayload skips sockets and fifos on Unix", async () => {
  if (process.platform === "win32") return;
  const root = mkTmp("payload-special-");
  let server: net.Server | null = null;
  try {
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "keep.bin"), Buffer.alloc(3));
    const fifo = path.join(cache, "native-fifo");
    const mkfifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (mkfifo.status !== 0) return;

    const socketPath = path.join(cache, "native-socket");
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(socketPath, resolve);
    });

    const plan = await planTarPayload({ parent: root, inputBasenames: ["cache"], topN: 5 });

    assert.deepEqual(plan.manifestEntries, ["cache/keep.bin"]);
    const skipped = new Map(plan.skipped.map((entry) => [entry.reason, entry.count]));
    assert.equal(skipped.get("special-fifo"), 1);
    assert.equal(skipped.get("special-socket"), 1);
  } finally {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
