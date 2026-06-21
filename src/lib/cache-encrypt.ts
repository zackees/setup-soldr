// AES-256-GCM cache-encryption wrapper. Issue #387 Feature 1.
//
// When the consumer sets `cache-encrypt-key`, every managed cache layer's
// .tar.zst archive is wrapped with authenticated encryption before being
// uploaded to the GitHub Actions Cache, and verified+decrypted before being
// handed to the existing decompress path. The wrapping is opt-in: when the
// key env var is absent, compressCache / decompressCache run today's
// plaintext path with no extra cache-API roundtrip and no extra disk pass.
//
// On-disk frame (little-endian where noted):
//   magic   : 8 bytes ASCII "SOLDRENC"
//   version : 1 byte  (currently 0x01)
//   iv      : 12 bytes random per archive
//   body    : ciphertext stream produced by aes-256-gcm
//   tag     : 16 bytes GCM authentication tag (appended last)
//
// AAD bound into the GCM tag includes the cache key and the runner platform,
// so a poisoned blob from one (key, layer) tuple cannot be replayed at
// another tuple even with the same encryption key.
//
// Failure modes:
//   - wrong key, tampered ciphertext, or AAD mismatch -> tag verification
//     fails -> caller surfaces a red error and refuses to unpack.
//   - missing key with encrypted entry on disk -> treated as a cold miss,
//     no error (lets users rotate keys without wiping caches).
//   - legacy plaintext entry with key set -> accepted with a warning;
//     the next save will write encrypted.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pipeline } from "node:stream/promises";

export const ENCRYPT_MAGIC = Buffer.from("SOLDRENC", "ascii");
export const ENCRYPT_VERSION = 0x01;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = ENCRYPT_MAGIC.length + 1 + IV_BYTES; // 21
export const KEY_BYTES = 32;

export type OnFailureMode = "error" | "skip";

export interface EncryptionConfig {
  /** Raw 32-byte AES-256 key. */
  key: Buffer;
  /**
   * Additional authenticated data bound into the GCM tag. The cache key
   * + runner platform are the bare minimum the issue calls for; callers
   * may extend it (e.g. with the layer label) by passing extra AAD when
   * constructing the config.
   */
  aad: Buffer;
  /**
   * What to do when a decrypt fails (wrong key, tampered, AAD mismatch).
   *   "error" -> caller throws / fails the step.
   *   "skip"  -> caller logs the failure and treats as cache miss.
   */
  onFailure: OnFailureMode;
}

/**
 * Parse a user-supplied key string into a 32-byte buffer.
 * Accepts:
 *   - 64-char hex (case-insensitive)
 *   - 44-char base64 (standard, with `=` padding)
 *   - 43-char base64url (no padding)
 * Rejects anything else with a precise diagnostic. The supplied raw value
 * is NEVER echoed back in the error message, so we do not accidentally leak
 * it into a log line.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new Error("cache-encrypt-key: empty value");
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) || /^[A-Za-z0-9+/]{44}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === KEY_BYTES) return buf;
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "base64url");
    if (buf.length === KEY_BYTES) return buf;
  }
  throw new Error(
    "cache-encrypt-key: expected a 256-bit key as 64-char hex, 44-char base64, or 43-char base64url",
  );
}

/**
 * Build the GCM additional-authenticated-data buffer for a cache layer.
 * Format: `v1|<platform>|<cacheKey>` (UTF-8 bytes). The leading version
 * lets us extend the AAD format later without invalidating old archives —
 * the version is part of the file frame too, so a reader knows which AAD
 * shape to construct.
 */
export function buildAad(cacheKey: string, platform: string = process.platform): Buffer {
  return Buffer.from(`v1|${platform}|${cacheKey}`, "utf8");
}

/**
 * Stream-encrypt `srcPath` (plaintext) into `dstPath` (framed ciphertext).
 *
 * Uses a temp sibling file + atomic rename so an interrupted encrypt cannot
 * leave a half-written archive at `dstPath` that the cache layer would
 * then upload. The temp lives next to `dstPath` (not in os.tmpdir()) so
 * the rename stays on the same filesystem.
 */
export async function encryptFile(
  srcPath: string,
  dstPath: string,
  cfg: EncryptionConfig,
): Promise<{ ciphertextBytes: number }> {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", cfg.key, iv);
  cipher.setAAD(cfg.aad);

  const tmpPath = `${dstPath}.tmp-${process.pid}-${Date.now()}`;
  const reader = fs.createReadStream(srcPath);
  const writer = fs.createWriteStream(tmpPath);
  // Write the frame header up-front so a partial file is unambiguously broken.
  writer.write(ENCRYPT_MAGIC);
  writer.write(Buffer.from([ENCRYPT_VERSION]));
  writer.write(iv);

  let ciphertextBytes = 0;
  try {
    await pipeline(reader, cipher, async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        ciphertextBytes += chunk.length;
        yield chunk;
      }
    }, writer);
    // pipeline closes the writer; reopen for the tag append.
    const tag = cipher.getAuthTag();
    if (tag.length !== TAG_BYTES) {
      throw new Error(`cache-encrypt: unexpected GCM tag length ${tag.length}`);
    }
    await fsp.appendFile(tmpPath, tag);
    await fsp.rename(tmpPath, dstPath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return { ciphertextBytes };
}

/**
 * Stream-decrypt `srcPath` (framed ciphertext) into `dstPath` (plaintext).
 *
 * Throws an Error tagged with `cause.code === "EAUTHFAIL"` when the GCM tag
 * fails to verify (wrong key, tampered ciphertext, or AAD mismatch). The
 * partial output file is removed before the error propagates so the caller
 * never observes half-decrypted bytes that look like a valid archive.
 */
export async function decryptFile(
  srcPath: string,
  dstPath: string,
  cfg: EncryptionConfig,
): Promise<{ plaintextBytes: number }> {
  const stat = await fsp.stat(srcPath);
  if (stat.size < HEADER_BYTES + TAG_BYTES) {
    throw makeDecryptError("encrypted archive is shorter than header+tag");
  }
  const handle = await fsp.open(srcPath, "r");
  let plaintextBytes = 0;
  const tmpPath = `${dstPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const headerBuf = Buffer.alloc(HEADER_BYTES);
    await handle.read(headerBuf, 0, HEADER_BYTES, 0);
    if (!headerBuf.subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC)) {
      throw makeDecryptError("magic byte mismatch");
    }
    const version = headerBuf[ENCRYPT_MAGIC.length];
    if (version !== ENCRYPT_VERSION) {
      throw makeDecryptError(`unsupported frame version ${version}`);
    }
    const iv = headerBuf.subarray(ENCRYPT_MAGIC.length + 1, HEADER_BYTES);

    const tagBuf = Buffer.alloc(TAG_BYTES);
    await handle.read(tagBuf, 0, TAG_BYTES, stat.size - TAG_BYTES);

    const decipher = crypto.createDecipheriv("aes-256-gcm", cfg.key, iv);
    decipher.setAAD(cfg.aad);
    decipher.setAuthTag(tagBuf);

    const bodyStart = HEADER_BYTES;
    const bodyEnd = stat.size - TAG_BYTES; // exclusive
    const reader = fs.createReadStream(srcPath, {
      start: bodyStart,
      end: bodyEnd - 1, // inclusive end for createReadStream
    });
    const writer = fs.createWriteStream(tmpPath);
    try {
      await pipeline(reader, decipher, async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          plaintextBytes += chunk.length;
          yield chunk;
        }
      }, writer);
    } catch (err) {
      // node:crypto raises "Unsupported state or unable to authenticate data"
      // on tag mismatch — normalize so callers can `catch (e) { if (e.code === "EAUTHFAIL") ... }`.
      throw makeDecryptError(
        err instanceof Error ? err.message : String(err),
      );
    }
    await fsp.rename(tmpPath, dstPath);
  } finally {
    await handle.close().catch(() => undefined);
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
  }
  return { plaintextBytes };
}

function makeDecryptError(detail: string): Error {
  const err = new Error(`cache-encrypt: ${detail}`);
  (err as NodeJS.ErrnoException).code = "EAUTHFAIL";
  return err;
}

/**
 * Inspect the first 8 bytes of `filePath`: is it a framed encrypted archive?
 * Used by decompressCache to dispatch between the plaintext and encrypted
 * decompression paths.
 */
export async function isEncryptedArchive(filePath: string): Promise<boolean> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(ENCRYPT_MAGIC.length);
    const { bytesRead } = await handle.read(buf, 0, ENCRYPT_MAGIC.length, 0);
    if (bytesRead < ENCRYPT_MAGIC.length) return false;
    return buf.equals(ENCRYPT_MAGIC);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Read the env-supplied cache-encryption configuration and build a
 * per-call EncryptionConfig keyed on the supplied cache key. Returns
 * `null` when no key is configured — the caller should then use the
 * plaintext path with no extra work.
 *
 * The key MUST be `core.setSecret()`-marked by the caller before this
 * runs so any incidental log line that captures it is auto-redacted.
 */
export function getEncryptionConfig(opts: {
  env: Record<string, string | undefined>;
  cacheKey: string;
}): EncryptionConfig | null {
  const raw = (opts.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] ?? "").trim();
  if (!raw) return null;
  const key = parseEncryptionKey(raw);
  const onFailureRaw = (opts.env["SETUP_SOLDR_CACHE_ENCRYPT_ON_FAILURE"] ?? "error")
    .trim()
    .toLowerCase();
  const onFailure: OnFailureMode = onFailureRaw === "skip" ? "skip" : "error";
  return {
    key,
    aad: buildAad(opts.cacheKey),
    onFailure,
  };
}

/**
 * Convenience: produce a temp file path adjacent to `archivePath` for the
 * intermediate decrypted artifact. Used by decompressCache.
 */
export function decryptedTempPathFor(archivePath: string): string {
  return path.join(
    path.dirname(archivePath),
    `.${path.basename(archivePath)}.plain-${process.pid}`,
  );
}

/** Test helper: in-memory round trip without disk. Exported only for tests. */
export function _testInMemoryRoundTrip(
  plaintext: Buffer,
  cfg: EncryptionConfig,
): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", cfg.key, iv);
  cipher.setAAD(cfg.aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPT_MAGIC, Buffer.from([ENCRYPT_VERSION]), iv, body, tag]);
}

// Re-export for callers that just want a "where can I write a scratch
// tmp file that doesn't pollute the runner-temp"; keeps the helper close
// to where it's consumed.
export const tmpdir = os.tmpdir;
