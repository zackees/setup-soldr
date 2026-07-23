import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { resolveDylintNightly } from "../src/lib/dylint-nightly.js";

function fixtures(selected = "nightly-2026-01-18"): { catalogue: Buffer; map: Buffer } {
  const map = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      nightlies: {
        "nightly-2026-01-18": {
          rust_version: "1.94",
          rustc_release: "1.94.0-nightly",
          rustc_commit_hash: "1111111111111111111111111111111111111111",
        },
        "nightly-2026-01-17": {
          rust_version: "1.94",
          rustc_release: "1.94.0-nightly",
          rustc_commit_hash: "2222222222222222222222222222222222222222",
        },
      },
      versions: {
        "1.94": {
          nightlies: ["nightly-2026-01-18", "nightly-2026-01-17"],
          selected,
        },
      },
    }),
  );
  const catalogue = Buffer.from(
    JSON.stringify({
      entries: [
        {
          owner: "zackees",
          repo: "soldr-toolchain",
          tag: "assets",
          asset: "rust-nightly-versions.v1.json",
          url: "https://assets.invalid/nightly-map.json",
          sha256: createHash("sha256").update(map).digest("hex"),
        },
      ],
    }),
  );
  return { catalogue, map };
}

test("selects the first newest nightly for a stable patch channel", async () => {
  const { catalogue, map } = fixtures();
  const requests: string[] = [];
  const identity = await resolveDylintNightly("1.94.1", {}, async (url) => {
    requests.push(url);
    return url.includes("catalogue") ? catalogue : map;
  });
  assert.equal(identity.channel, "nightly-2026-01-18");
  assert.equal(identity.rustcRelease, "1.94.0-nightly");
  assert.equal(identity.rustcCommitHash.length, 40);
  assert.equal(requests.length, 2);
});

test("rejects a selected nightly that is not the first entry", async () => {
  const { catalogue, map } = fixtures("nightly-2026-01-17");
  await assert.rejects(
    resolveDylintNightly("1.94.1", {}, async (url) =>
      url.includes("catalogue") ? catalogue : map,
    ),
    /not its first newest entry/,
  );
});

test("retries the catalogue once but never accepts a bad map digest", async () => {
  const { catalogue } = fixtures();
  let catalogueRequests = 0;
  let mapRequests = 0;
  await assert.rejects(
    resolveDylintNightly("1.94.1", {}, async (url) => {
      if (url.includes("catalogue")) {
        catalogueRequests += 1;
        return catalogue;
      }
      mapRequests += 1;
      if (mapRequests === 2) assert.match(url, /[?&]dylint_retry=/);
      return Buffer.from("tampered");
    }),
    /unverified bytes were rejected/,
  );
  assert.equal(catalogueRequests, 2);
  assert.equal(mapRequests, 2);
});
