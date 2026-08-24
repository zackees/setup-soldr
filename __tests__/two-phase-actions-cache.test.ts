import test from "node:test";
import assert from "node:assert/strict";
import { saveReservedCache, type Reservation } from "../src/lib/two-phase-actions-cache.js";

const winner: Reservation = {
  service: "v1",
  compressionMethod: "zstd" as Reservation["compressionMethod"],
  cacheId: 42,
};

test("reservation conflict never invokes the archive producer", async () => {
  let produced = false;
  const result = await saveReservedCache({
    paths: ["cache.tzst"],
    key: "cook-test",
    reserve: async () => null,
    produce: async () => {
      produced = true;
      throw new Error("producer must not run");
    },
  });
  assert.deepEqual(result, { status: "skipped-reservation" });
  assert.equal(produced, false);
});

test("only the reservation winner produces and uploads under concurrency", async () => {
  let next = 0;
  let produced = 0;
  let uploaded = 0;
  const run = () => saveReservedCache({
    paths: ["cache.tzst"],
    key: "cook-concurrent",
    reserve: async () => (next++ === 0 ? winner : null),
    produce: async () => {
      produced += 1;
      return { archivePath: "cache.tzst", archiveBytes: 12 };
    },
    prepareUpload: async () => ({ archivePath: "actions-cache.tzst", archiveBytes: 24 }),
    upload: async () => {
      uploaded += 1;
      return 42;
    },
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(produced, 1);
  assert.equal(uploaded, 1);
  assert.deepEqual(results.map((r) => r.status).sort(), ["saved", "skipped-reservation"]);
});

test("uploads an Actions-cache wrapper instead of the producer archive", async () => {
  let uploadedPath = "";
  let uploadedBytes = 0;
  const result = await saveReservedCache({
    paths: ["payload.tar.zst"],
    key: "cook-wrapped",
    reserve: async () => winner,
    produce: async () => ({ archivePath: "payload.tar.zst", archiveBytes: 182 }),
    prepareUpload: async (_reservation, produced) => {
      assert.equal(produced.archivePath, "payload.tar.zst");
      return { archivePath: "actions-cache.tar.zst", archiveBytes: 211 };
    },
    upload: async (_reservation, prepared) => {
      uploadedPath = prepared.archivePath;
      uploadedBytes = prepared.archiveBytes;
      return 42;
    },
  });
  assert.equal(result.status, "saved");
  assert.equal(uploadedPath, "actions-cache.tar.zst");
  assert.equal(uploadedBytes, 211);
  assert.equal(result.archive?.archivePath, "payload.tar.zst");
  assert.equal(result.archive?.archiveBytes, 182);
});
