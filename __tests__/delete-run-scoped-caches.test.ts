import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { before, test } from "node:test";

// Non-literal specifier: the .mjs script is plain ESM outside the TS graph.
// Loaded in a before() hook because this test file is a CJS module to tsc,
// which forbids top-level await (TS1309) even though Node runs the file as
// ESM via syntax detection.
const scriptSpecifier = "../scripts/delete-run-scoped-caches.mjs";
interface RunScopedCachesScript {
  deriveNamespacePrefix(cacheGeneration: string, runId: string): string;
  matchesNamespace(key: string, prefix: string): boolean;
  deleteRunScopedCaches(deps: Record<string, unknown>): Promise<{
    prefix: string;
    matched: { id: number; key: string }[];
    deleted: number;
    gone: number;
    failed: { id: number; key: string; status: number }[];
    leftover: { id: number; key: string }[];
    permissionDenied: boolean;
  }>;
}
let script!: RunScopedCachesScript;
before(async () => {
  script = (await import(scriptSpecifier)) as RunScopedCachesScript;
});

// Keys below are verbatim from the live repository cache inventory captured
// for #513's RED evidence (2026-09-22): completed runs leaving unreachable
// namespaced entries behind.
const SELFTEST_RUN = "35670871242";
const SELFTEST_PREFIX = `cook-selftest-${SELFTEST_RUN}-`;
const REMAT_RUN = "35668611552";
const REMAT_PREFIX = `cook-remat-${REMAT_RUN}-`;
const CONSUMER_RUN = "35668612072";
const CONSUMER_PREFIX = `consumer-soldr-${CONSUMER_RUN}-`;

const LIVE_KEYS = {
  selftestCookBase:
    "cook-base-v2-linux-x64-glibc-rustc1.95.0-f9e7e4902-l807a0e45e873771b-soldrv0.9.21-" +
    `xcook-selftest-${SELFTEST_RUN}-1`,
  selftestBuildCache:
    `setup-soldr-buildcache-v2-linux-x64-61a9e93b92c9fb42-cook-selftest-${SELFTEST_RUN}-1-807a0e45e873771b`,
  rematRegistry:
    `setup-soldr-cargoregistry-v1-linux-x64-a9d7b3716bcc9fc3-xcook-remat-${REMAT_RUN}-1-99be7e58c3434b1a`,
  consumerDelta:
    "cook-delta-v2-linux-x64-glibc-rustc1.95.0-fe40aeb69-l807a0e45e873771b-soldrv0.9.21-" +
    `xconsumer-soldr-${CONSUMER_RUN}-1-s8889772a58e3-g866f58bba4ebff02`,
  otherRunSelftest:
    `cook-base-v2-linux-x64-glibc-rustc1.95.0-f9e7e4902-l807a0e45e873771b-soldrv0.9.21-` +
    "xcook-selftest-35668611450-1",
  siblingConsumer:
    "cook-base-v2-linux-x64-glibc-rustc1.95.0-f79809f9c-l86c6e82485a319d4-soldrv0.9.21-" +
    `xconsumer-zccache-${CONSUMER_RUN}-1`,
  sharedSoloToolchain: "solo-toolchain-v3-linux-x64-glibc-rustc1.95.0-cnone-tnone-soldrv0.9.21",
  sharedRegistry: "setup-soldr-cargoregistry-v1-linux-x64-807a0e45e873771b-61a9e93b92c9fb42",
  sharedSoldrMini: "soldr-mini-v2-linux-x64-glibc-v0.9.21",
};

test("deriveNamespacePrefix strips only the attempt segment", () => {
  assert.equal(
    script.deriveNamespacePrefix(`cook-selftest-${SELFTEST_RUN}-1`, SELFTEST_RUN),
    SELFTEST_PREFIX,
  );
  assert.equal(
    script.deriveNamespacePrefix(`cook-remat-${REMAT_RUN}-12`, REMAT_RUN),
    REMAT_PREFIX,
  );
  assert.equal(
    script.deriveNamespacePrefix(`consumer-soldr-${CONSUMER_RUN}-1`, CONSUMER_RUN),
    CONSUMER_PREFIX,
  );
});

test("deriveNamespacePrefix refuses namespaces that do not name this run", () => {
  // Empty guards.
  assert.throws(() => script.deriveNamespacePrefix("", SELFTEST_RUN), /CACHE_GENERATION is empty/);
  assert.throws(() => script.deriveNamespacePrefix(`cook-selftest-${SELFTEST_RUN}-1`, ""), /GITHUB_RUN_ID is empty/);
  assert.throws(
    () => script.deriveNamespacePrefix(`cook-selftest-${SELFTEST_RUN}-1`, "not-a-number"),
    /is not numeric/,
  );
  // Generation from an unrelated run.
  assert.throws(
    () => script.deriveNamespacePrefix("cook-selftest-999-1", SELFTEST_RUN),
    /does not embed run id/,
  );
  // Missing attempt segment: stripping the bare run id must not be allowed
  // to produce a prefix that no longer names this run.
  assert.throws(
    () => script.deriveNamespacePrefix(`cook-selftest-${SELFTEST_RUN}`, SELFTEST_RUN),
    /does not embed run id/,
  );
});

test("matchesNamespace accepts this run's real keys only", () => {
  assert.equal(script.matchesNamespace(LIVE_KEYS.selftestCookBase, SELFTEST_PREFIX), true);
  assert.equal(script.matchesNamespace(LIVE_KEYS.selftestBuildCache, SELFTEST_PREFIX), true);
  assert.equal(script.matchesNamespace(LIVE_KEYS.rematRegistry, REMAT_PREFIX), true);
  assert.equal(script.matchesNamespace(LIVE_KEYS.consumerDelta, CONSUMER_PREFIX), true);
});

test("matchesNamespace rejects other runs, sibling namespaces, and shared layers", () => {
  assert.equal(script.matchesNamespace(LIVE_KEYS.otherRunSelftest, SELFTEST_PREFIX), false);
  assert.equal(script.matchesNamespace(LIVE_KEYS.siblingConsumer, CONSUMER_PREFIX), false);
  assert.equal(script.matchesNamespace(LIVE_KEYS.sharedSoloToolchain, SELFTEST_PREFIX), false);
  assert.equal(script.matchesNamespace(LIVE_KEYS.sharedRegistry, REMAT_PREFIX), false);
  assert.equal(script.matchesNamespace(LIVE_KEYS.sharedSoldrMini, SELFTEST_PREFIX), false);
  // Trailing-dash boundary: run 123's prefix must not match run 1234.
  assert.equal(script.matchesNamespace(`cook-selftest-1234-1`, "cook-selftest-123-"), false);
  assert.equal(script.matchesNamespace(`cook-selftest-123-1`, "cook-selftest-123-"), true);
  // Bare run id embedded without this workflow's namespace is not a match.
  assert.equal(
    script.matchesNamespace(`setup-soldr-v4-linux-x64-${SELFTEST_RUN}abcdef`, SELFTEST_PREFIX),
    false,
  );
});

interface FakeCacheEntry {
  id: number;
  key: string;
  ref?: string;
}

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fakeCacheServer(
  entries: FakeCacheEntry[],
  opts: {
    listStatus?: number;
    deleteStatus?: (id: number) => number;
    /** Simulate a DELETE that claims success but leaves the entry behind. */
    keepIds?: number[];
  } = {},
) {
  const alive = new Set(entries.map((entry) => entry.id));
  const deletedIds: number[] = [];
  const listUrls: string[] = [];
  const fetchImpl = async (url: string, init: { method?: string } = {}) => {
    if ((init.method ?? "GET") === "DELETE") {
      const id = Number(url.split("/").pop());
      const status = opts.deleteStatus?.(id) ?? 204;
      if (status < 200 || status >= 300) {
        if (status === 404) {
          // The API's contract for 404: the entry is (already) gone.
          alive.delete(id);
        }
        return response(status);
      }
      if (!opts.keepIds?.includes(id)) alive.delete(id);
      deletedIds.push(id);
      return response(204);
    }
    listUrls.push(url);
    if (opts.listStatus) return response(opts.listStatus);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const refFilter = new URL(url).searchParams.get("ref");
    const aliveEntries = entries.filter(
      (entry) => alive.has(entry.id) && (!refFilter || entry.ref === refFilter),
    );
    const start = (page - 1) * 100;
    return response(200, { actions_caches: aliveEntries.slice(start, start + 100) });
  };
  return { fetchImpl, deletedIds, listUrls };
}

const BASE_DEPS = {
  runId: SELFTEST_RUN,
  cacheGeneration: `cook-selftest-${SELFTEST_RUN}-1`,
  repo: "zackees/setup-soldr",
  token: "test-token",
  sleepImpl: async () => {},
};

test("deleteRunScopedCaches deletes exactly this run's entries and verifies them gone", async () => {
  const entries: FakeCacheEntry[] = [
    { id: 1, key: LIVE_KEYS.selftestCookBase },
    { id: 2, key: LIVE_KEYS.selftestBuildCache },
    { id: 3, key: LIVE_KEYS.sharedSoloToolchain },
    { id: 4, key: LIVE_KEYS.otherRunSelftest },
  ];
  const server = fakeCacheServer(entries);
  const result = await script.deleteRunScopedCaches({ ...BASE_DEPS, fetchImpl: server.fetchImpl });

  assert.equal(result.prefix, SELFTEST_PREFIX);
  assert.deepEqual(
    result.matched.map((entry) => entry.id).sort((a, b) => a - b),
    [1, 2],
  );
  assert.equal(result.deleted, 2);
  assert.equal(result.gone, 0);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.leftover, []);
  assert.equal(result.permissionDenied, false);
  assert.deepEqual(server.deletedIds.sort((a, b) => a - b), [1, 2]);
});

test("#513 deleteRunScopedCaches never deletes another ref's entries", async () => {
  const entries: FakeCacheEntry[] = [
    { id: 1, key: LIVE_KEYS.selftestCookBase, ref: "refs/pull/524/merge" },
    // Same namespace text on a different ref must survive.
    { id: 2, key: LIVE_KEYS.selftestBuildCache, ref: "refs/pull/526/merge" },
    { id: 3, key: LIVE_KEYS.sharedSoloToolchain, ref: "refs/pull/524/merge" },
  ];
  const server = fakeCacheServer(entries);
  const result = await script.deleteRunScopedCaches({
    ...BASE_DEPS,
    ref: "refs/pull/524/merge",
    fetchImpl: server.fetchImpl,
  });
  assert.deepEqual(server.deletedIds, [1]);
  assert.ok(server.listUrls.every((url) => new URL(url).searchParams.get("ref") === "refs/pull/524/merge"));
  assert.deepEqual(result.leftover, []);
});

// A server that ignores the ref query parameter still cannot widen the scope.
test("#513 deleteRunScopedCaches filters by ref client-side too", async () => {
  const entries = [
    { id: 1, key: LIVE_KEYS.selftestCookBase, ref: "refs/pull/524/merge" },
    { id: 2, key: LIVE_KEYS.selftestBuildCache, ref: "refs/pull/526/merge" },
  ];
  const deleted: number[] = [];
  const fetchImpl = async (url: string, init: { method?: string } = {}) => {
    if (init.method === "DELETE") {
      const id = Number(url.split("/").pop());
      deleted.push(id);
      return response(204);
    }
    return response(200, { actions_caches: entries.filter((e) => !deleted.includes(e.id)) });
  };
  await script.deleteRunScopedCaches({ ...BASE_DEPS, ref: "refs/pull/524/merge", fetchImpl });
  assert.deepEqual(deleted, [1]);
});

test("deleteRunScopedCaches paginates the cache listing", async () => {
  const entries: FakeCacheEntry[] = [];
  for (let i = 1; i <= 100; i += 1) entries.push({ id: i, key: `unrelated-key-${i}` });
  entries.push({ id: 101, key: LIVE_KEYS.selftestCookBase });
  entries.push({ id: 102, key: LIVE_KEYS.selftestBuildCache });
  const server = fakeCacheServer(entries);

  const result = await script.deleteRunScopedCaches({ ...BASE_DEPS, fetchImpl: server.fetchImpl });

  assert.equal(server.listUrls.length >= 3, true, "initial list + verify list must both page");
  assert.equal(result.deleted, 2);
  assert.deepEqual(server.deletedIds.sort((a, b) => a - b), [101, 102]);
});

test("deleteRunScopedCaches treats a 404 delete as already-gone success", async () => {
  const server = fakeCacheServer([{ id: 7, key: LIVE_KEYS.selftestCookBase }], {
    deleteStatus: () => 404,
  });
  const result = await script.deleteRunScopedCaches({ ...BASE_DEPS, fetchImpl: server.fetchImpl });

  assert.equal(result.gone, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.leftover, []);
  assert.equal(result.permissionDenied, false);
});

test("deleteRunScopedCaches reports permission denial without failing verification", async () => {
  const server = fakeCacheServer(
    [
      { id: 1, key: LIVE_KEYS.selftestCookBase },
      { id: 2, key: LIVE_KEYS.selftestBuildCache },
    ],
    { deleteStatus: () => 403 },
  );
  let sleeps = 0;
  const result = await script.deleteRunScopedCaches({
    ...BASE_DEPS,
    fetchImpl: server.fetchImpl,
    sleepImpl: async () => {
      sleeps += 1;
    },
  });

  assert.equal(result.permissionDenied, true);
  assert.deepEqual(result.failed, []);
  assert.equal(sleeps, 0, "verification retries are pointless without write access");
});

test("deleteRunScopedCaches treats an unlistable repository as permission denial", async () => {
  const server = fakeCacheServer([], { listStatus: 403 });
  const result = await script.deleteRunScopedCaches({ ...BASE_DEPS, fetchImpl: server.fetchImpl });

  assert.equal(result.permissionDenied, true);
  assert.deepEqual(result.matched, []);
});

test("deleteRunScopedCaches surfaces non-permission delete failures", async () => {
  const server = fakeCacheServer([{ id: 5, key: LIVE_KEYS.selftestCookBase }], {
    deleteStatus: () => 500,
  });
  const result = await script.deleteRunScopedCaches({ ...BASE_DEPS, fetchImpl: server.fetchImpl });

  assert.equal(result.permissionDenied, false);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.status, 500);
});

test("deleteRunScopedCaches fails verification when a delete silently does nothing", async () => {
  const server = fakeCacheServer([{ id: 9, key: LIVE_KEYS.selftestCookBase }], {
    keepIds: [9],
  });
  let sleeps = 0;
  const result = await script.deleteRunScopedCaches({
    ...BASE_DEPS,
    fetchImpl: server.fetchImpl,
    sleepImpl: async () => {
      sleeps += 1;
    },
  });

  assert.equal(result.deleted, 1, "the API claimed success");
  assert.equal(result.leftover.length, 1, "but the entry is still present");
  assert.equal(sleeps, 2, "verification must retry before giving up");
});

test("deleteRunScopedCaches refuses to run without a token", async () => {
  await assert.rejects(
    script.deleteRunScopedCaches({ ...BASE_DEPS, token: "", fetchImpl: async () => response(500) }),
    /no token supplied/,
  );
});

// Workflow-structure guards: the cleanup jobs must keep their finalizer
// condition and their actions: write grant, or the whole mechanism silently
// stops working (#498 is what happens when cleanup cannot run).
function cleanupSection(workflow: string): string {
  const text = readFileSync(`.github/workflows/${workflow}`, "utf8");
  const idx = text.indexOf("\n  cleanup:");
  assert.notEqual(idx, -1, `${workflow} must define a "cleanup" job`);
  return text.slice(idx);
}

test("cook validation workflows run cleanup as an always() finalizer with actions: write", () => {
  const expectations: { workflow: string; needs: string }[] = [
    { workflow: "cook-soldr-selftest.yml", needs: "needs: [seed, warm]" },
    { workflow: "cook-rematerialization.yml", needs: "needs: [baseline, seed, delta-seed, warm]" },
    { workflow: "_cook-consumer-rematerialization.yml", needs: "needs: [seed, warm]" },
  ];
  for (const { workflow, needs } of expectations) {
    const section = cleanupSection(workflow);
    assert.ok(section.includes("if: ${{ always() }}"), `${workflow}: cleanup must be if: always()`);
    assert.ok(section.includes("actions: write"), `${workflow}: cleanup needs actions: write`);
    assert.ok(section.includes(needs), `${workflow}: cleanup must needs() every other job so it runs last`);
    assert.ok(
      section.includes("delete-run-scoped-caches.mjs"),
      `${workflow}: cleanup must run the run-scoped cache deleter`,
    );
  }
});

test("the reusable consumer workflow's caller grants the actions: write ceiling", () => {
  const text = readFileSync(".github/workflows/cook-downstream-rematerialization.yml", "utf8");
  const permissionsIdx = text.indexOf("\npermissions:");
  assert.notEqual(permissionsIdx, -1, "caller must declare workflow permissions");
  const permissionsBlock = text.slice(permissionsIdx, text.indexOf("\nconcurrency:", permissionsIdx));
  assert.ok(
    permissionsBlock.includes("actions: write"),
    "caller must grant actions: write or the called cleanup job is capped at read",
  );
});

// #513 contract: any workflow that saves run-scoped keys (a cache-key-suffix
// or CACHE_GENERATION built from github.run_id) must own an always()
// cleanup job with actions: write that runs the deleter after every other
// job. A pull_request workflow that forces save-cache: "true" must be run-
// scoped, or its entries pile up on refs/pull/*/merge forever.
function workflowFiles(): string[] {
  return readdirSync(".github/workflows")
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

function topLevelJobs(text: string): string[] {
  const jobsIdx = text.indexOf("\njobs:\n");
  assert.notEqual(jobsIdx, -1);
  return [...text.slice(jobsIdx).matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]!);
}

function savesRunScopedKeys(text: string): boolean {
  const generation = /^\s*CACHE_GENERATION:.*github\.run_id/m.test(text);
  const suffixes = [...text.matchAll(/^\s*cache-key-suffix:(.*)$/gm)].map((m) => m[1]!);
  return suffixes.some((v) => v.includes("github.run_id") || (generation && v.includes("CACHE_GENERATION")));
}

test("#513 every workflow saving run-scoped keys has an always() cleanup of exactly that run", () => {
  const scoped = workflowFiles().filter((name) =>
    savesRunScopedKeys(readFileSync(`.github/workflows/${name}`, "utf8")),
  );
  for (const expected of [
    "cook-soldr-selftest.yml",
    "cook-rematerialization.yml",
    "_cook-consumer-rematerialization.yml",
    "cross-prepare.yml",
  ]) {
    assert.ok(scoped.includes(expected), `${expected} is expected to save run-scoped keys`);
  }
  for (const name of scoped) {
    const text = readFileSync(`.github/workflows/${name}`, "utf8");
    const section = cleanupSection(name);
    assert.ok(section.includes("if: ${{ always() }}"), `${name}: cleanup must be if: always()`);
    assert.ok(section.includes("actions: write"), `${name}: cleanup needs actions: write`);
    assert.ok(section.includes("delete-run-scoped-caches.mjs"), `${name}: cleanup must run the deleter`);
    const needsLine = /\n    needs: \[([^\]]*)\]/.exec(section);
    assert.ok(needsLine, `${name}: cleanup must declare needs`);
    const needs = needsLine[1]!.split(",").map((v) => v.trim());
    for (const job of topLevelJobs(text).filter((j) => j !== "cleanup")) {
      assert.ok(needs.includes(job), `${name}: cleanup must need ${job} so it runs last`);
    }
    // The deleter derives its namespace from CACHE_GENERATION, which must
    // embed both run_id and run_attempt.
    assert.match(text, /CACHE_GENERATION:.*\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  }
});

test("#513 pull_request workflows that force save-cache must use a run-scoped namespace", () => {
  for (const name of workflowFiles()) {
    const text = readFileSync(`.github/workflows/${name}`, "utf8");
    const onPullRequest = /^\s{2}pull_request:/m.test(text);
    const forcesSave = /^\s*save-cache:\s*["']?true/m.test(text);
    if (!onPullRequest || !forcesSave) continue;
    assert.ok(savesRunScopedKeys(text), `${name}: forces save-cache on pull_request without a run-scoped cache-key-suffix`);
  }
});
