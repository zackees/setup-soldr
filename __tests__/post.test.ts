import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("src/post.ts imports cleanly and exposes `run`", async () => {
  const mod = (await import("../src/post.js")) as { run?: () => Promise<void> };
  assert.equal(typeof mod.run, "function");
});

test("post.run no-ops when no resolveResult state present", async () => {
  const mod = (await import("../src/post.js")) as { run: () => Promise<void> };
  // Make sure GITHUB_STATE points at a temp file with no key set.
  const root = mkTmp("post-empty-state-");
  try {
    const statePath = path.join(root, "state");
    fs.writeFileSync(statePath, "", "utf8");
    const previousState = process.env["GITHUB_STATE"];
    process.env["GITHUB_STATE"] = statePath;
    try {
      await mod.run();
    } finally {
      if (previousState === undefined) delete process.env["GITHUB_STATE"];
      else process.env["GITHUB_STATE"] = previousState;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // No assertion beyond "did not throw" — the function should silently exit
  // when there's nothing to save.
});

test("post.run parses bad state gracefully", async () => {
  const mod = (await import("../src/post.js")) as { run: () => Promise<void> };
  // Inject malformed JSON via STATE_resolveResult (the @actions/core
  // toolkit env-var naming convention for getState/saveState).
  const prev = process.env["STATE_resolveResult"];
  process.env["STATE_resolveResult"] = "{not valid json";
  try {
    await mod.run();
  } finally {
    if (prev === undefined) delete process.env["STATE_resolveResult"];
    else process.env["STATE_resolveResult"] = prev;
  }
});

test("final cache summary includes zccache stats and cache layer outcomes", async () => {
  const mod = (await import("../src/post.js")) as {
    buildFinalCacheSummary: (result: any, state: any, saves: any) => any;
    formatFinalCacheSummaryMarkdown: (summary: any) => string;
  };
  const root = mkTmp("post-final-summary-");
  try {
    const buildCachePath = path.join(root, "cache", "zccache");
    const statsPath = path.join(buildCachePath, "logs", "last-session-stats.json");
    fs.mkdirSync(path.dirname(statsPath), { recursive: true });
    fs.writeFileSync(
      statsPath,
      JSON.stringify({
        status: "ok",
        session_id: "session-1",
        compilations: 10,
        hits: 7,
        misses: 3,
        non_cacheable: 2,
        errors: 1,
        hit_rate: 0.7,
      }),
      "utf8",
    );

    const result = {
      setupCache: { key: "setup-key" },
      targetCache: { key: "target-key" },
      buildCache: { key: "build-key", path: buildCachePath },
      cargoRegistryCache: { key: "registry-key" },
    };
    const summary = mod.buildFinalCacheSummary(
      result,
      {
        setupCacheEnabled: true,
        setupCacheExactHit: true,
        setupCacheMatchedKey: "setup-key",
        targetCacheEnabled: true,
        targetCacheExactHit: false,
        targetCacheMatchedKey: "target-restore-key",
        buildCacheEnabled: true,
        buildCacheExactHit: false,
        buildCacheMatchedKey: "",
        cargoRegistryCacheEnabled: false,
        cargoRegistryCacheExactHit: false,
        cargoRegistryCacheMatchedKey: "",
      },
      {
        buildCache: { status: "saved", cache_id: 42 },
        cargoRegistryCache: { status: "disabled" },
      },
    );

    assert.equal(summary.zccache_session.status, "ok");
    assert.equal(summary.zccache_session.stats.hits, 7);
    assert.equal(summary.build_cache.save.cache_id, 42);
    assert.equal(summary.target_cache.restore_status, "restore-key-hit");
    assert.equal(summary.cargo_registry_cache.restore_status, "disabled");

    const markdown = mod.formatFinalCacheSummaryMarkdown(summary);
    assert.match(markdown, /hits=7 misses=3/);
    assert.match(markdown, /saved id=42/);
    assert.match(markdown, /restore-key hit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
