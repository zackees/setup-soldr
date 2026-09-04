import assert from "node:assert/strict";
import test from "node:test";
import {
  PYPI_WHEEL_PLATFORM_TAGS,
  REQUIRED_RELEASE_TARGETS,
  assertReleaseReady,
  isSymbolsSidecar,
  pypiWheelHasTarget,
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

test("isSymbolsSidecar recognizes the debug-symbol sidecar naming contract", () => {
  assert.equal(isSymbolsSidecar("soldr-v0.9.12-x86_64-unknown-linux-gnu-symbols.tar.zst"), true);
  assert.equal(isSymbolsSidecar("soldr-v0.9.12-aarch64-unknown-linux-gnu-symbols.tar.gz"), true);
  assert.equal(isSymbolsSidecar("soldr-v0.9.12-x86_64-pc-windows-msvc-symbols.zip"), true);
  assert.equal(isSymbolsSidecar("soldr-v0.9.12-x86_64-unknown-linux-gnu.tar.zst"), false);
  assert.equal(isSymbolsSidecar("soldr-v0.9.12-x86_64-unknown-linux-gnu-symbols-old.tar.zst"), false);
  assert.equal(isSymbolsSidecar("soldr-v0.9.12-x86_64-unknown-linux-gnu-symbols"), false);
});

test("release readiness treats a release that only publishes symbols sidecars as not ready", () => {
  const target = REQUIRED_RELEASE_TARGETS[0];
  const release = {
    tag_name: "v0.9.12",
    draft: false,
    assets: REQUIRED_RELEASE_TARGETS.flatMap((t) => [
      {
        name: `soldr-v0.9.12-${t}-symbols.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${t}-symbols.tar.zst`,
      },
    ]),
  };
  assert.throws(() => assertReleaseReady(release), new RegExp(target));
});

test("release readiness ignores a symbols sidecar listed before the real archive", () => {
  const release = {
    tag_name: "v0.9.12",
    draft: false,
    assets: REQUIRED_RELEASE_TARGETS.flatMap((t) => [
      {
        name: `soldr-v0.9.12-${t}-symbols.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${t}-symbols.tar.zst`,
      },
      {
        name: `soldr-v0.9.12-${t}.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${t}.tar.zst`,
      },
    ]),
  };
  assert.doesNotThrow(() => assertReleaseReady(release));
});

test("release readiness accepts a PyPI wheel when a combined archive is absent", () => {
  const release = readyRelease();
  release["assets"] = (release["assets"] as unknown[]).slice(1);
  const target = REQUIRED_RELEASE_TARGETS[0];
  const platformTag = PYPI_WHEEL_PLATFORM_TAGS[target];
  const pypi = {
    urls: [
      {
        filename: `soldr-0.9.0-py3-none-${platformTag}.whl`,
        url: `https://files.pythonhosted.org/soldr-0.9.0-py3-none-${platformTag}.whl`,
        yanked: false,
        digests: { sha256: "a".repeat(64) },
      },
    ],
  };

  assert.equal(pypiWheelHasTarget((pypi.urls as unknown[])[0], target), true);
  assert.doesNotThrow(() => assertReleaseReady(release, REQUIRED_RELEASE_TARGETS, pypi));
});

test("release readiness rejects yanked or wrong-platform wheel fallbacks", () => {
  const target = "aarch64-pc-windows-msvc";
  const good = {
    filename: "soldr-0.9.0-py3-none-win_arm64.whl",
    url: "https://files.pythonhosted.org/soldr-0.9.0-py3-none-win_arm64.whl",
    digests: { sha256: "b".repeat(64) },
  };
  assert.equal(pypiWheelHasTarget(good, target), true);
  assert.equal(pypiWheelHasTarget({ ...good, yanked: true }, target), false);
  assert.equal(pypiWheelHasTarget({ ...good, filename: "soldr-0.9.0-py3-none-win_amd64.whl" }, target), false);
  assert.equal(pypiWheelHasTarget({ ...good, digests: {} }, target), false);
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
