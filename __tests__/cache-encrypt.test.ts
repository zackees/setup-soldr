// Tests for src/lib/cache-encrypt.ts and the cache-compress integration.
// Issue #387 Feature 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as io from "@actions/io";

import {
  buildAad,
  decryptFile,
  ENCRYPT_MAGIC,
  ENCRYPT_VERSION,
  encryptFile,
  getEncryptionConfig,
  isEncryptedArchive,
  parseEncryptionKey,
} from "../src/lib/cache-encrypt.js";
import {
  compressCache,
  decompressCache,
  detectCompressMagic,
} from "../src/lib/cache-compress.js";

// compress/decompress integration tests need a real zstd binary on PATH.
// On hosted runners and most dev hosts this is present; if it isn't (e.g.
// some Windows dev boxes), skip those tests rather than fail — the
// underlying encrypt/decrypt helpers are exercised by the pure file-level
// tests above, which don't depend on zstd.
async function zstdAvailable(): Promise<boolean> {
  try {
    return Boolean(await io.which("zstd", false));
  } catch {
    return false;
  }
}

function mkKey(): Buffer {
  return crypto.randomBytes(32);
}

function hex(buf: Buffer): string {
  return buf.toString("hex");
}

async function mkWorkdir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "setup-soldr-encrypt-test-"));
}

// --- parseEncryptionKey --------------------------------------------------

test("parseEncryptionKey accepts 64-char hex", () => {
  const key = mkKey();
  const parsed = parseEncryptionKey(hex(key));
  assert.deepEqual(parsed, key);
});

test("parseEncryptionKey accepts 44-char base64 (with padding)", () => {
  const key = mkKey();
  const parsed = parseEncryptionKey(key.toString("base64"));
  assert.deepEqual(parsed, key);
});

test("parseEncryptionKey accepts 43-char base64url (no padding)", () => {
  const key = mkKey();
  const parsed = parseEncryptionKey(key.toString("base64url"));
  assert.deepEqual(parsed, key);
});

test("parseEncryptionKey is case-insensitive on hex", () => {
  const key = mkKey();
  const parsed = parseEncryptionKey(hex(key).toUpperCase());
  assert.deepEqual(parsed, key);
});

test("parseEncryptionKey rejects empty input", () => {
  assert.throws(() => parseEncryptionKey(""), /empty value/);
  assert.throws(() => parseEncryptionKey("   "), /empty value/);
});

test("parseEncryptionKey rejects malformed input without echoing the value", () => {
  // The value contains a sentinel — make sure it does NOT appear in the
  // error message (no echoing user-supplied secret material into logs).
  const badValue = "this-is-not-a-valid-key-XSECRETSENTINELx";
  try {
    parseEncryptionKey(badValue);
    assert.fail("should have thrown");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.ok(msg.includes("256-bit"), `expected diagnostic, got: ${msg}`);
    assert.ok(
      !msg.includes("XSECRETSENTINELx"),
      `error message must not echo the raw value: ${msg}`,
    );
  }
});

test("parseEncryptionKey rejects a 60-char hex (wrong length)", () => {
  assert.throws(() => parseEncryptionKey("ab".repeat(30)), /256-bit/);
});

// --- buildAad ------------------------------------------------------------

test("buildAad encodes platform and cacheKey", () => {
  const aad = buildAad("setup-soldr-build-abc", "linux");
  assert.equal(aad.toString("utf8"), "v1|linux|setup-soldr-build-abc");
});

test("buildAad with different cacheKeys produces different AAD", () => {
  const a = buildAad("key-a", "linux");
  const b = buildAad("key-b", "linux");
  assert.notDeepEqual(a, b);
});

// --- isEncryptedArchive --------------------------------------------------

test("isEncryptedArchive returns true for SOLDRENC-magic files", async () => {
  const dir = await mkWorkdir();
  try {
    const p = path.join(dir, "x.enc");
    await fsp.writeFile(p, Buffer.concat([ENCRYPT_MAGIC, Buffer.from([ENCRYPT_VERSION]), Buffer.alloc(12)]));
    assert.equal(await isEncryptedArchive(p), true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("isEncryptedArchive returns false for short files", async () => {
  const dir = await mkWorkdir();
  try {
    const p = path.join(dir, "tiny");
    await fsp.writeFile(p, Buffer.from("hi"));
    assert.equal(await isEncryptedArchive(p), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("isEncryptedArchive returns false for nonexistent path", async () => {
  assert.equal(
    await isEncryptedArchive(path.join(os.tmpdir(), "does-not-exist-" + crypto.randomBytes(4).toString("hex"))),
    false,
  );
});

// --- file-level encrypt/decrypt round-trip -------------------------------

test("encryptFile + decryptFile round-trip preserves bytes", async () => {
  const dir = await mkWorkdir();
  try {
    const key = mkKey();
    const cfg = { key, aad: buildAad("cache-key-1"), onFailure: "error" as const };
    const plaintext = crypto.randomBytes(64 * 1024); // 64 KB
    const srcPath = path.join(dir, "plain.bin");
    const encPath = path.join(dir, "enc.bin");
    const outPath = path.join(dir, "round.bin");
    await fsp.writeFile(srcPath, plaintext);

    await encryptFile(srcPath, encPath, cfg);
    assert.equal(await isEncryptedArchive(encPath), true, "encrypted file should carry SOLDRENC magic");

    await decryptFile(encPath, outPath, cfg);
    const out = await fsp.readFile(outPath);
    assert.deepEqual(out, plaintext);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("decryptFile rejects tampered ciphertext with EAUTHFAIL", async () => {
  const dir = await mkWorkdir();
  try {
    const key = mkKey();
    const cfg = { key, aad: buildAad("k"), onFailure: "error" as const };
    const plaintext = Buffer.from("payload bytes that survive a round trip");
    const srcPath = path.join(dir, "p.bin");
    const encPath = path.join(dir, "e.bin");
    await fsp.writeFile(srcPath, plaintext);
    await encryptFile(srcPath, encPath, cfg);

    // Flip a byte in the body (after the 21-byte header, before the 16-byte tag).
    const handle = await fsp.open(encPath, "r+");
    const stat = await handle.stat();
    const pos = Math.floor(stat.size / 2);
    const one = Buffer.alloc(1);
    await handle.read(one, 0, 1, pos);
    one[0] = (one[0] ?? 0) ^ 0xff;
    await handle.write(one, 0, 1, pos);
    await handle.close();

    await assert.rejects(
      decryptFile(encPath, path.join(dir, "out.bin"), cfg),
      (err: unknown) => {
        const e = err as NodeJS.ErrnoException;
        return e.code === "EAUTHFAIL";
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("decryptFile rejects wrong key with EAUTHFAIL", async () => {
  const dir = await mkWorkdir();
  try {
    const keyA = mkKey();
    const keyB = mkKey();
    const cfgEncrypt = { key: keyA, aad: buildAad("k"), onFailure: "error" as const };
    const cfgDecrypt = { key: keyB, aad: buildAad("k"), onFailure: "error" as const };
    const srcPath = path.join(dir, "p.bin");
    const encPath = path.join(dir, "e.bin");
    await fsp.writeFile(srcPath, Buffer.from("secret material"));
    await encryptFile(srcPath, encPath, cfgEncrypt);

    await assert.rejects(
      decryptFile(encPath, path.join(dir, "out.bin"), cfgDecrypt),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EAUTHFAIL",
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("decryptFile rejects wrong AAD (cross-layer replay) with EAUTHFAIL", async () => {
  const dir = await mkWorkdir();
  try {
    const key = mkKey();
    const cfgA = { key, aad: buildAad("layer-A"), onFailure: "error" as const };
    const cfgB = { key, aad: buildAad("layer-B"), onFailure: "error" as const };
    const srcPath = path.join(dir, "p.bin");
    const encPath = path.join(dir, "e.bin");
    await fsp.writeFile(srcPath, Buffer.from("payload"));
    await encryptFile(srcPath, encPath, cfgA);

    await assert.rejects(
      decryptFile(encPath, path.join(dir, "out.bin"), cfgB),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EAUTHFAIL",
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("decryptFile leaves no partial output on auth failure", async () => {
  const dir = await mkWorkdir();
  try {
    const key = mkKey();
    const cfg = { key, aad: buildAad("k"), onFailure: "error" as const };
    const bad = mkKey();
    const srcPath = path.join(dir, "p.bin");
    const encPath = path.join(dir, "e.bin");
    const outPath = path.join(dir, "out.bin");
    await fsp.writeFile(srcPath, crypto.randomBytes(32 * 1024));
    await encryptFile(srcPath, encPath, cfg);
    await assert.rejects(
      decryptFile(encPath, outPath, { ...cfg, key: bad }),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EAUTHFAIL",
    );
    assert.equal(fs.existsSync(outPath), false, "no partial decrypted output should remain");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// --- getEncryptionConfig (env-driven) ------------------------------------

test("getEncryptionConfig returns null when env key absent", () => {
  assert.equal(
    getEncryptionConfig({ env: {}, cacheKey: "anything" }),
    null,
  );
});

test("getEncryptionConfig parses key and builds AAD per cacheKey", () => {
  const key = mkKey();
  const cfg = getEncryptionConfig({
    env: { SETUP_SOLDR_CACHE_ENCRYPT_KEY: hex(key) },
    cacheKey: "build-cache-abc",
  });
  assert.ok(cfg, "expected non-null config");
  assert.deepEqual(cfg!.key, key);
  assert.equal(
    cfg!.aad.toString("utf8"),
    `v1|${process.platform}|build-cache-abc`,
  );
  assert.equal(cfg!.onFailure, "error");
});

test("getEncryptionConfig respects on-failure=skip", () => {
  const key = mkKey();
  const cfg = getEncryptionConfig({
    env: {
      SETUP_SOLDR_CACHE_ENCRYPT_KEY: hex(key),
      SETUP_SOLDR_CACHE_ENCRYPT_ON_FAILURE: "skip",
    },
    cacheKey: "k",
  });
  assert.equal(cfg!.onFailure, "skip");
});

test("getEncryptionConfig defaults unknown on-failure to error", () => {
  const key = mkKey();
  const cfg = getEncryptionConfig({
    env: {
      SETUP_SOLDR_CACHE_ENCRYPT_KEY: hex(key),
      SETUP_SOLDR_CACHE_ENCRYPT_ON_FAILURE: "explode",
    },
    cacheKey: "k",
  });
  assert.equal(cfg!.onFailure, "error");
});

// --- cache-compress integration: SOLDRENC roundtrip through compress -----

test("compressCache → decompressCache encrypted round-trip preserves files", async (t) => {
  if (!(await zstdAvailable())) { t.skip("zstd not on PATH"); return; }
  const dir = await mkWorkdir();
  try {
    const key = mkKey();
    const cacheDir = path.join(dir, "fake-cache");
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, "a.txt"), "alpha\n");
    await fsp.writeFile(path.join(cacheDir, "b.txt"), "beta beta\n");
    // Restore a known sub-tree
    await fsp.mkdir(path.join(cacheDir, "sub"), { recursive: true });
    await fsp.writeFile(path.join(cacheDir, "sub", "nested.bin"), crypto.randomBytes(1024));

    const cfg = { key, aad: buildAad("integration-test-key"), onFailure: "error" as const };
    const compress = await compressCache({
      cacheDir,
      codec: "zstd",
      level: "3",
      encryption: cfg,
    });
    assert.ok(compress.archivePath, "expected archivePath");
    // The on-disk file should now carry the SOLDRENC magic, not zstd magic.
    assert.equal(await isEncryptedArchive(compress.archivePath!), true);
    assert.equal(await detectCompressMagic(compress.archivePath!), "unknown");

    // Wipe and decompress back.
    await fsp.rm(cacheDir, { recursive: true, force: true });
    await decompressCache({
      archivePath: compress.archivePath!,
      targetDir: cacheDir,
      encryption: cfg,
    });
    assert.equal((await fsp.readFile(path.join(cacheDir, "a.txt"), "utf8")), "alpha\n");
    assert.equal((await fsp.readFile(path.join(cacheDir, "b.txt"), "utf8")), "beta beta\n");
    const nested = await fsp.readFile(path.join(cacheDir, "sub", "nested.bin"));
    assert.equal(nested.length, 1024);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("decompressCache rejects encrypted archive when no encryption config provided", async (t) => {
  if (!(await zstdAvailable())) { t.skip("zstd not on PATH"); return; }
  const dir = await mkWorkdir();
  try {
    const key = mkKey();
    const cacheDir = path.join(dir, "fake-cache");
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, "a.txt"), "hi\n");
    const cfg = { key, aad: buildAad("k"), onFailure: "error" as const };
    const compress = await compressCache({
      cacheDir,
      codec: "zstd",
      level: "3",
      encryption: cfg,
    });
    await fsp.rm(cacheDir, { recursive: true, force: true });

    await assert.rejects(
      decompressCache({
        archivePath: compress.archivePath!,
        targetDir: cacheDir,
        encryption: null,
      }),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EENCNOKEY",
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("decompressCache emits EAUTHFAIL when key is wrong", async (t) => {
  if (!(await zstdAvailable())) { t.skip("zstd not on PATH"); return; }
  const dir = await mkWorkdir();
  try {
    const cacheDir = path.join(dir, "fake-cache");
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, "a.txt"), "hi\n");
    const goodKey = mkKey();
    const badKey = mkKey();
    const cfgGood = { key: goodKey, aad: buildAad("k"), onFailure: "error" as const };
    const cfgBad = { key: badKey, aad: buildAad("k"), onFailure: "error" as const };
    const compress = await compressCache({
      cacheDir,
      codec: "zstd",
      level: "3",
      encryption: cfgGood,
    });
    await fsp.rm(cacheDir, { recursive: true, force: true });

    await assert.rejects(
      decompressCache({
        archivePath: compress.archivePath!,
        targetDir: cacheDir,
        encryption: cfgBad,
      }),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EAUTHFAIL",
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("decompressCache accepts legacy plaintext archive when encryption is enabled (mixed-mode tolerance)", async (t) => {
  if (!(await zstdAvailable())) { t.skip("zstd not on PATH"); return; }
  const dir = await mkWorkdir();
  try {
    const cacheDir = path.join(dir, "fake-cache");
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, "legacy.txt"), "still works\n");
    // Compress WITHOUT encryption (legacy entry)
    const compress = await compressCache({
      cacheDir,
      codec: "zstd",
      level: "3",
      encryption: null,
    });
    await fsp.rm(cacheDir, { recursive: true, force: true });

    // Now restore WITH encryption configured — should accept the legacy archive.
    const key = mkKey();
    const cfg = { key, aad: buildAad("k"), onFailure: "error" as const };
    await decompressCache({
      archivePath: compress.archivePath!,
      targetDir: cacheDir,
      encryption: cfg,
    });
    assert.equal(
      await fsp.readFile(path.join(cacheDir, "legacy.txt"), "utf8"),
      "still works\n",
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// --- env-driven path: compressCache uses env when cacheKey is supplied ----

test("compressCache encrypts when env key + cacheKey are supplied (no explicit encryption opt)", async (t) => {
  if (!(await zstdAvailable())) { t.skip("zstd not on PATH"); return; }
  const dir = await mkWorkdir();
  const prevKey = process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"];
  try {
    const key = mkKey();
    process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] = hex(key);
    const cacheDir = path.join(dir, "env-driven-cache");
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, "x.txt"), "x\n");
    const compress = await compressCache({
      cacheDir,
      codec: "zstd",
      level: "3",
      cacheKey: "my-cache-key",
    });
    assert.ok(compress.archivePath);
    assert.equal(await isEncryptedArchive(compress.archivePath!), true);
  } finally {
    if (prevKey === undefined) delete process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"];
    else process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] = prevKey;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("compressCache does NOT encrypt when env key absent and no explicit encryption opt", async (t) => {
  if (!(await zstdAvailable())) { t.skip("zstd not on PATH"); return; }
  const dir = await mkWorkdir();
  const prevKey = process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"];
  try {
    delete process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"];
    const cacheDir = path.join(dir, "plain-cache");
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, "y.txt"), "y\n");
    const compress = await compressCache({
      cacheDir,
      codec: "zstd",
      level: "3",
      cacheKey: "some-key",
    });
    assert.ok(compress.archivePath);
    assert.equal(await isEncryptedArchive(compress.archivePath!), false);
    assert.equal(await detectCompressMagic(compress.archivePath!), "zstd");
  } finally {
    if (prevKey !== undefined) process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] = prevKey;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
