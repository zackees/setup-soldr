"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  detectArchiveCodec,
  ZSTD_MAGIC,
  GZIP_MAGIC,
} = require("../src/main.js");

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-cc-test-"));
}

test("detectArchiveCodec returns 'missing' when file does not exist", () => {
  const dir = mkTmpDir();
  try {
    const missingPath = path.join(dir, "does-not-exist.tar.zst");
    assert.equal(detectArchiveCodec(missingPath), "missing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectArchiveCodec returns 'zstd' when leading bytes match 0x28 B5 2F FD", () => {
  const dir = mkTmpDir();
  try {
    const filePath = path.join(dir, "sample.tar.zst");
    // Real zstd magic plus some filler payload bytes.
    const payload = Buffer.concat([ZSTD_MAGIC, Buffer.from([0, 1, 2, 3, 4])]);
    fs.writeFileSync(filePath, payload);
    assert.equal(detectArchiveCodec(filePath), "zstd");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectArchiveCodec returns 'gzip' when leading bytes match 0x1F 8B", () => {
  const dir = mkTmpDir();
  try {
    const filePath = path.join(dir, "legacy.tar.gz");
    const payload = Buffer.concat([
      GZIP_MAGIC,
      Buffer.from([0x08, 0x00, 0x00, 0x00]),
    ]);
    fs.writeFileSync(filePath, payload);
    assert.equal(detectArchiveCodec(filePath), "gzip");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectArchiveCodec returns 'unknown' for arbitrary leading bytes", () => {
  const dir = mkTmpDir();
  try {
    const filePath = path.join(dir, "garbage.bin");
    fs.writeFileSync(
      filePath,
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x42]),
    );
    assert.equal(detectArchiveCodec(filePath), "unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectArchiveCodec returns 'unknown' for files smaller than the magic prefix", () => {
  const dir = mkTmpDir();
  try {
    const filePath = path.join(dir, "tiny.bin");
    fs.writeFileSync(filePath, Buffer.from([0x28]));
    assert.equal(detectArchiveCodec(filePath), "unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZSTD_MAGIC bytes match the documented zstd frame magic 0x28 B5 2F FD", () => {
  assert.equal(ZSTD_MAGIC.length, 4);
  assert.deepEqual(Array.from(ZSTD_MAGIC), [0x28, 0xb5, 0x2f, 0xfd]);
});

test("GZIP_MAGIC bytes match the gzip member magic 0x1F 8B", () => {
  assert.equal(GZIP_MAGIC.length, 2);
  assert.deepEqual(Array.from(GZIP_MAGIC), [0x1f, 0x8b]);
});
