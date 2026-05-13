import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectCompressMagic } from "../src/lib/cache-compress.js";

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
