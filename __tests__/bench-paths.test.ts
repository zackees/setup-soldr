import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as path from "node:path";

// bench-paths.mjs is plain ESM with no .ts imports. Imports happen inside
// each test() callback to keep this file as a TS CommonJS module (tsconfig
// `module: Node16` + no `"type": "module"` in package.json), matching the
// existing test-file convention (see main.test.ts).
type BenchPaths = {
  LAYER_NAMES: ReadonlyArray<string>;
  pathsForLayer: (layer: string, opts?: { env?: NodeJS.ProcessEnv; workloadDir?: string }) =>
    Array<{ parent: string; basename: string }>;
  isActiveLayer: (layer: string) => boolean;
};

async function loadBenchPaths(): Promise<BenchPaths> {
  return (await import("../scripts/bench-paths.mjs")) as unknown as BenchPaths;
}

const FAKE_ENV = {
  HOME: "/home/runner",
  USERPROFILE: "/home/runner",
  RUNNER_TEMP: "/runner/_temp",
  CARGO_HOME: "/home/runner/.cargo",
  RUSTUP_HOME: "/home/runner/.rustup",
  ZCCACHE_CACHE_DIR: "/home/runner/.cache/zccache",
};

const FAKE_WORKLOAD = "/work/setup-soldr/scripts/bench-workloads/demo-small";

test("LAYER_NAMES covers the issue inventory (baseline + 7 prod + all-on)", async () => {
  const benchPaths = await loadBenchPaths();
  const expected = [
    "baseline",
    "soldr-mini",
    "solo-toolchain",
    "cargo-registry",
    "cook",
    "build",
    "target",
    "setup-cache",
    "all-on",
  ];
  assert.deepEqual([...benchPaths.LAYER_NAMES], expected);
});

test("baseline resolves to no paths (skip snapshot)", async () => {
  const benchPaths = await loadBenchPaths();
  assert.deepEqual(benchPaths.pathsForLayer("baseline", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD }), []);
  assert.equal(benchPaths.isActiveLayer("baseline"), false);
});

test("every non-baseline layer resolves to at least one path", async () => {
  const benchPaths = await loadBenchPaths();
  for (const layer of benchPaths.LAYER_NAMES) {
    if (layer === "baseline") continue;
    const ps = benchPaths.pathsForLayer(layer, { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD });
    assert.ok(ps.length > 0, `layer ${layer} should resolve to >=1 path`);
    for (const p of ps) {
      assert.equal(typeof p.parent, "string");
      assert.equal(typeof p.basename, "string");
      assert.ok(p.parent.length > 0 && p.basename.length > 0);
      assert.ok(path.isAbsolute(p.parent), `parent for ${layer} must be absolute, got ${p.parent}`);
    }
    assert.equal(benchPaths.isActiveLayer(layer), true);
  }
});

test("cargo-registry bundles the three ~/.cargo siblings", async () => {
  const benchPaths = await loadBenchPaths();
  const ps = benchPaths.pathsForLayer("cargo-registry", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD });
  const basenames = ps.map((p) => p.basename).sort();
  assert.deepEqual(basenames, [".global-cache", "git", "registry"]);
  for (const p of ps) {
    assert.equal(p.parent, "/home/runner/.cargo");
  }
});

test("solo-toolchain spans rustup + cargo bin", async () => {
  const benchPaths = await loadBenchPaths();
  const ps = benchPaths.pathsForLayer("solo-toolchain", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD });
  const tuples = ps.map((p) => `${p.parent}/${p.basename}`).sort();
  assert.deepEqual(tuples, ["/home/runner/.cargo/bin", "/home/runner/.rustup/toolchains"]);
});

test("build layer uses ZCCACHE_CACHE_DIR", async () => {
  const benchPaths = await loadBenchPaths();
  const ps = benchPaths.pathsForLayer("build", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD });
  assert.equal(ps.length, 1);
  const first = ps[0]!;
  assert.equal(first.parent, "/home/runner/.cache");
  assert.equal(first.basename, "zccache");
});

test("target + cook both point at workload's target dir (overlap is real)", async () => {
  const benchPaths = await loadBenchPaths();
  const tgt = benchPaths.pathsForLayer("target", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD });
  const cook = benchPaths.pathsForLayer("cook", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD });
  assert.deepEqual(tgt, cook);
});

test("all-on deduplicates overlapping paths", async () => {
  const benchPaths = await loadBenchPaths();
  const ps = benchPaths.pathsForLayer("all-on", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD });
  const keys = ps.map((p) => `${p.parent}::${p.basename}`);
  assert.equal(new Set(keys).size, keys.length, "all-on must dedupe");
  assert.ok(ps.some((p) => p.basename === "registry"));
  assert.ok(ps.some((p) => p.basename === "toolchains"));
  assert.ok(ps.some((p) => p.basename === "target"));
});

test("unknown layer throws", async () => {
  const benchPaths = await loadBenchPaths();
  assert.throws(
    () => benchPaths.pathsForLayer("nope", { env: FAKE_ENV, workloadDir: FAKE_WORKLOAD }),
    /unknown layer/,
  );
});

test("env override beats homedir defaults", async () => {
  const benchPaths = await loadBenchPaths();
  const altEnv = { ...FAKE_ENV, CARGO_HOME: "/custom/cargo" };
  const ps = benchPaths.pathsForLayer("cargo-registry", { env: altEnv, workloadDir: FAKE_WORKLOAD });
  for (const p of ps) assert.equal(p.parent, "/custom/cargo");
});
