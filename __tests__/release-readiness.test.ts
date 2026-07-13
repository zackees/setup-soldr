import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_RELEASE_TARGETS,
  assertReleaseReady,
  retryReleaseRequest,
} from "../src/lib/release-readiness.js";

function readyRelease(): Record<string, unknown> {
  return {
    tag_name: "v0.8.9",
    draft: false,
    assets: REQUIRED_RELEASE_TARGETS.map((target) => ({
      name: `soldr-${target}.tar.zst`,
      browser_download_url: `https://example.invalid/${target}.tar.zst`,
    })),
  };
}

test("release readiness accepts a published release with every supported asset", () => {
  assert.doesNotThrow(() => assertReleaseReady(readyRelease()));
});

test("release readiness rejects drafts and missing target assets", () => {
  assert.throws(() => assertReleaseReady({ ...readyRelease(), draft: true }), /draft/);
  const release = readyRelease();
  release["assets"] = (release["assets"] as unknown[]).slice(1);
  assert.throws(() => assertReleaseReady(release), /x86_64-unknown-linux-gnu/);
});

test("a transient 404 retries the exact requested release", async () => {
  let calls = 0;
  const result = await retryReleaseRequest(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("GitHub API returned HTTP 404 for exact tag");
      return "v0.8.9";
    },
    { sleep: async () => undefined },
  );
  assert.equal(result, "v0.8.9");
  assert.equal(calls, 2);
});

test("exhausted 404 retries fail without a fallback version", async () => {
  let calls = 0;
  await assert.rejects(
    retryReleaseRequest(
      async () => {
        calls += 1;
        throw new Error("GitHub API returned HTTP 404 for exact tag");
      },
      { attempts: 2, sleep: async () => undefined },
    ),
    /after 2 attempts.*404/,
  );
  assert.equal(calls, 2);
});
