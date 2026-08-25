import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  auditDependencyYanks,
  cratesIoSparsePath,
  readRegistryDependencies,
  waitForYankAuditResult,
  writeYankAuditResult,
  type YankAuditDependency,
} from "../src/lib/yank-audit.js";

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

function dependency(name: string, version: string): YankAuditDependency {
  return { name, version, source: CRATES_IO };
}

function sparseFetch(records: Record<string, Array<{ vers: string; yanked: boolean }>>): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const crateName = String(input).split("/").at(-1) ?? "";
    const body = (records[crateName] ?? []).map((record) => JSON.stringify(record)).join("\n");
    return new Response(body, { status: records[crateName] ? 200 : 404 });
  }) as typeof fetch;
}

test("Cargo.lock parser selects registry packages and deduplicates the closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-lock-"));
  try {
    const lockfile = path.join(root, "Cargo.lock");
    fs.writeFileSync(lockfile, `
version = 4

[[package]]
name = "workspace"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "${CRATES_IO}"

[[package]]
name = "serde"
version = "1.0.0"
source = "${CRATES_IO}"

[[package]]
name = "git-dep"
version = "2.0.0"
source = "git+https://example.invalid/repo"
`, "utf8");
    assert.deepEqual(readRegistryDependencies(lockfile), [dependency("serde", "1.0.0")]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sparse-index paths follow the crates.io name layout", () => {
  assert.equal(cratesIoSparsePath("a"), "1/a");
  assert.equal(cratesIoSparsePath("ab"), "2/ab");
  assert.equal(cratesIoSparsePath("abc"), "3/a/abc");
  assert.equal(cratesIoSparsePath("Serde_JSON"), "se/rd/serde_json");
});

test("audit reports the yanked crate and version", async () => {
  const result = await auditDependencyYanks(
    [dependency("serde", "1.0.0"), dependency("itoa", "1.0.0")],
    {
      fetchImpl: sparseFetch({
        serde: [{ vers: "1.0.0", yanked: true }],
        itoa: [{ vers: "1.0.0", yanked: false }],
      }),
    },
  );
  assert.equal(result.status, "yanked");
  assert.deepEqual(result.yanked, [{ name: "serde", version: "1.0.0" }]);
  assert.equal(result.checkedCount, 2);
});

test("audit reports clean only after every registry dependency is checked", async () => {
  const result = await auditDependencyYanks([dependency("serde", "1.0.0")], {
    fetchImpl: sparseFetch({ serde: [{ vers: "1.0.0", yanked: false }] }),
  });
  assert.equal(result.status, "clean");
  assert.equal(result.checkedCount, 1);
  assert.deepEqual(result.errors, []);
});

test("registry failure and unsupported registries are not checked, never clean", async () => {
  const unreachable = await auditDependencyYanks([dependency("serde", "1.0.0")], {
    fetchImpl: (async () => { throw new Error("network unreachable"); }) as typeof fetch,
  });
  assert.equal(unreachable.status, "not-checked");
  assert.match(unreachable.errors?.[0] ?? "", /network unreachable/);

  const unsupported = await auditDependencyYanks([
    { name: "private", version: "1.2.3", source: "registry+https://registry.example/index" },
  ]);
  assert.equal(unsupported.status, "not-checked");
  assert.match(unsupported.errors?.[0] ?? "", /not supported/);
});

test("one global deadline aborts every stalled request wave before post joins", async () => {
  const stalledFetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
  const dependencies = Array.from({ length: 40 }, (_, index) =>
    dependency(`crate-${index}`, "1.0.0"));
  const started = Date.now();
  const result = await auditDependencyYanks(dependencies, {
    fetchImpl: stalledFetch,
    concurrency: 2,
    requestTimeoutMs: 5_000,
    overallTimeoutMs: 25,
  });
  assert.equal(result.status, "not-checked");
  assert.ok(Date.now() - started < 1_000, "global deadline must not wait for successive waves");
  assert.ok(result.errors?.some((error) => /aborted|deadline/.test(error)));
});

test("post join waits for a pending worker result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-result-"));
  try {
    const resultPath = path.join(root, "result.json");
    writeYankAuditResult(resultPath, { status: "pending" });
    setTimeout(() => writeYankAuditResult(resultPath, {
      status: "clean",
      checkedAt: new Date().toISOString(),
      dependencyCount: 1,
      checkedCount: 1,
    }), 20);
    const result = await waitForYankAuditResult(resultPath, { timeoutMs: 1_000, pollMs: 5 });
    assert.equal(result.status, "clean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post join timeout is reported as not checked", async () => {
  const result = await waitForYankAuditResult("missing-result.json", {
    timeoutMs: 10,
    pollMs: 2,
  });
  assert.equal(result.status, "not-checked");
  assert.equal(result.joinTimedOut, true);
  assert.match(result.errors?.[0] ?? "", /did not finish/);
});
