"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { clampLevel, tarBaseAndDir, run } = require("../src/post.js");

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-cc-post-test-"));
}

test("clampLevel clamps to [1, 22] and falls back to 3 for non-numeric input", () => {
  assert.equal(clampLevel("3"), 3);
  assert.equal(clampLevel("1"), 1);
  assert.equal(clampLevel("22"), 22);
  assert.equal(clampLevel("0"), 1);
  assert.equal(clampLevel("-5"), 1);
  assert.equal(clampLevel("100"), 22);
  assert.equal(clampLevel("fast"), 3);
  assert.equal(clampLevel(""), 3);
  assert.equal(clampLevel(undefined), 3);
});

test("tarBaseAndDir splits the cache directory into its parent and base name", () => {
  const dir = mkTmpDir();
  try {
    const cacheDir = path.join(dir, "zccache");
    fs.mkdirSync(cacheDir);
    const result = tarBaseAndDir(cacheDir);
    assert.equal(result.parent, dir);
    assert.equal(result.base, "zccache");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("post.run is a no-op when the cache-dir does not exist", async () => {
  const dir = mkTmpDir();
  const archivePath = path.join(dir, "ghost.tar.zst");
  // Pre-create an archive to make sure run() does not delete it when the
  // source dir is missing.
  fs.writeFileSync(archivePath, Buffer.from("preexisting"));

  const prevEnv = { ...process.env };
  // GitHub Actions emulation: state is read via STATE_<name> env vars.
  process.env["STATE_cache-dir"] = path.join(dir, "ghost");
  process.env["STATE_codec"] = "zstd";
  process.env["STATE_level"] = "3";
  process.env["GITHUB_OUTPUT"] = path.join(dir, "out");
  process.env["GITHUB_STATE"] = path.join(dir, "state");

  try {
    await run();
    // The pre-existing unrelated archive is left untouched because cache-dir
    // is missing.
    assert.ok(fs.existsSync(archivePath));
  } finally {
    process.env = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("post.run does not throw when state is empty (cache-dir unset)", async () => {
  const dir = mkTmpDir();
  const prevEnv = { ...process.env };
  delete process.env["STATE_cache-dir"];
  delete process.env["STATE_codec"];
  delete process.env["STATE_level"];
  delete process.env["INPUT_CACHE-DIR"];
  process.env["GITHUB_OUTPUT"] = path.join(dir, "out");
  process.env["GITHUB_STATE"] = path.join(dir, "state");

  try {
    await run();
    // No throw == success.
    assert.ok(true);
  } finally {
    process.env = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("post.run produces a non-empty .tar.zst archive next to a populated cache-dir", async (t) => {
  // Skip when zstd is unavailable on this runner - this protects local dev
  // boxes that don't have zstd installed.
  const { execSync } = require("node:child_process");
  try {
    execSync("zstd --version", { stdio: "ignore" });
  } catch {
    t.skip("zstd not on PATH; skipping end-to-end archive test");
    return;
  }
  try {
    execSync("tar --version", { stdio: "ignore" });
  } catch {
    t.skip("tar not on PATH; skipping end-to-end archive test");
    return;
  }

  const dir = mkTmpDir();
  const cacheDir = path.join(dir, "payload");
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(
    path.join(cacheDir, "hello.txt"),
    "hello cache compress\n",
  );

  const prevEnv = { ...process.env };
  process.env["STATE_cache-dir"] = cacheDir;
  process.env["STATE_codec"] = "zstd";
  process.env["STATE_level"] = "3";
  process.env["GITHUB_OUTPUT"] = path.join(dir, "out");
  process.env["GITHUB_STATE"] = path.join(dir, "state");

  try {
    await run();
    const archivePath = `${cacheDir}.tar.zst`;
    assert.ok(fs.existsSync(archivePath), `expected ${archivePath} to exist`);
    const head = Buffer.alloc(4);
    const fd = fs.openSync(archivePath, "r");
    try {
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    assert.deepEqual(
      Array.from(head),
      [0x28, 0xb5, 0x2f, 0xfd],
      "archive must begin with zstd magic bytes",
    );
    const size = fs.statSync(archivePath).size;
    assert.ok(size > 4, "archive should contain more than just the magic");
  } finally {
    process.env = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
