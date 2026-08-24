import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  assertArchiveWorthSaving,
  checkRestoredArchive,
  unusablePayloadMessage,
} from "../src/lib/cache-payload.js";

async function tmpdir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "cache-payload-"));
}

describe("cache payload validation (#475)", () => {
  it("rejects a zero-byte archive", async () => {
    const dir = await tmpdir();
    const archive = path.join(dir, "empty.tar.zst");
    await fsp.writeFile(archive, "");

    const check = await checkRestoredArchive(archive);

    assert.equal(check.usable, false, "a 0-byte archive is never a usable payload");
    assert.equal(check.rejection, "empty");
    assert.equal(check.bytes, 0);
  });

  it("rejects an archive that is not on disk", async () => {
    const dir = await tmpdir();
    const check = await checkRestoredArchive(path.join(dir, "never-written.tar.zst"));
    assert.equal(check.usable, false);
    assert.equal(check.rejection, "missing");
  });

  it("accepts an archive with content", async () => {
    const dir = await tmpdir();
    const archive = path.join(dir, "real.tar.zst");
    await fsp.writeFile(archive, Buffer.alloc(4096, 7));

    const check = await checkRestoredArchive(archive);

    assert.equal(check.usable, true);
    assert.equal(check.rejection, null);
    assert.equal(check.bytes, 4096);
  });

  it("names the key in the warning, because the failure looks like a hit", async () => {
    const msg = unusablePayloadMessage("cook-cache-base", "cook-base-v2-abc", {
      usable: false,
      bytes: 0,
      rejection: "empty",
    });

    assert.match(msg, /cook-cache-base/);
    assert.match(msg, /cook-base-v2-abc/, "the key is what makes this searchable");
    assert.match(msg, /MISS/, "must state the outcome, not just the symptom");
  });

  it("refuses to upload an empty archive, so the key is not poisoned", async () => {
    const dir = await tmpdir();
    const archive = path.join(dir, "empty.tar.zst");
    await fsp.writeFile(archive, "");

    await assert.rejects(
      () => assertArchiveWorthSaving("cook-cache-base", archive),
      /refusing to upload/,
      "an immutable cache key must never receive an empty payload",
    );
  });

  it("returns the size when the archive is worth saving", async () => {
    const dir = await tmpdir();
    const archive = path.join(dir, "real.tar.zst");
    await fsp.writeFile(archive, Buffer.alloc(128, 3));

    assert.equal(await assertArchiveWorthSaving("cook-cache-base", archive), 128);
  });
});
