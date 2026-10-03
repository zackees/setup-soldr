// Runner-aware cache profile (zackees/ci.yml#227, zackees/clud#1740).
//
// `ACT=true` is the local-runner signal (act / act2, e.g. under bosn). A
// local runner has no Actions-cache budget and a slow refetch, so an empty
// cache-size or compression input resolves to the local default (no payload
// cap, zstd -1) instead of the GitHub default. An explicit input always wins
// on both runner kinds, and GitHub behaviour is unchanged.
//
// Every test passes its env explicitly so the suite gives the same answers
// when it runs under act itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CACHE_PROFILE_KNOBS,
  cacheProfileDefault,
  describeCacheProfile,
  isLocalRunner,
  resolveCacheProfileInput,
  type CacheProfileInputKnob,
} from "../src/lib/local-profile.js";
import { isLocalRunner as savePolicyIsLocalRunner } from "../src/lib/save-policy.js";
import { readRawInputs } from "../src/lib/raw-inputs.js";
import { buildDeferredCookPlan } from "../src/lib/deferred-cook.js";

process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

const GITHUB_ENV: Record<string, string | undefined> = {};
const ACT_ENV: Record<string, string | undefined> = { ACT: "true" };

const repoRoot = process.cwd();
const readRepo = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), "utf8");

// The four action inputs whose default depends on the runner kind.
const INPUT_TABLE: Array<{ knob: CacheProfileInputKnob; github: string; local: string; explicit: string }> = [
  { knob: "cache-payload-max-bytes", github: "6GiB", local: "0", explicit: "2GiB" },
  { knob: "cache-payload-warn-bytes", github: "512MiB", local: "4GiB", explicit: "1GiB" },
  { knob: "target-cache-compress-level", github: "3", local: "1", explicit: "7" },
  { knob: "solo-toolchain-cache-level", github: "9", local: "1", explicit: "19" },
];

test("isLocalRunner is the one ACT signal shared with the save policy", () => {
  assert.equal(isLocalRunner(GITHUB_ENV), false);
  assert.equal(isLocalRunner(ACT_ENV), true);
  assert.equal(isLocalRunner({ ACT: "1" }), true);
  assert.equal(isLocalRunner({ ACT: "false" }), false);
  // RUNNER_ENVIRONMENT stays github-hosted under act2 for parity; it is not the signal.
  assert.equal(isLocalRunner({ RUNNER_ENVIRONMENT: "self-hosted" }), false);
  assert.equal(savePolicyIsLocalRunner, isLocalRunner);
});

for (const row of INPUT_TABLE) {
  test(`${row.knob}: empty input + ACT unset -> GitHub default ${row.github}`, () => {
    assert.equal(resolveCacheProfileInput(row.knob, "", isLocalRunner(GITHUB_ENV)), row.github);
    assert.equal(resolveCacheProfileInput(row.knob, "   ", false), row.github);
    assert.equal(resolveCacheProfileInput(row.knob, undefined, false), row.github);
  });

  test(`${row.knob}: empty input + ACT=true -> local default ${row.local}`, () => {
    assert.equal(resolveCacheProfileInput(row.knob, "", isLocalRunner(ACT_ENV)), row.local);
  });

  test(`${row.knob}: explicit input wins on both runner kinds`, () => {
    assert.equal(resolveCacheProfileInput(row.knob, row.explicit, false), row.explicit);
    assert.equal(resolveCacheProfileInput(row.knob, row.explicit, true), row.explicit);
    // An explicit value equal to the other profile's default is still explicit.
    assert.equal(resolveCacheProfileInput(row.knob, row.github, true), row.github);
    assert.equal(resolveCacheProfileInput(row.knob, row.local, false), row.local);
  });
}

test("hard-coded zstd sites: GitHub levels unchanged, level 1 under ACT", () => {
  const expected: Record<string, [string, string]> = {
    "cook-base-zstd-level": ["9", "1"],
    "cook-delta-zstd-level": ["3", "1"],
    "soldr-mini-zstd-level": ["19", "1"],
    "cargo-registry-extras-zstd-level": ["3", "1"],
  };
  for (const [knob, [github, local]] of Object.entries(expected)) {
    assert.equal(cacheProfileDefault(knob as never, false), github, `${knob} github`);
    assert.equal(cacheProfileDefault(knob as never, true), local, `${knob} local`);
  }
  // Every knob has both a GitHub and a local default.
  for (const knob of CACHE_PROFILE_KNOBS) {
    assert.ok(cacheProfileDefault(knob, false), `${knob} github default`);
    assert.ok(cacheProfileDefault(knob, true), `${knob} local default`);
  }
});

test("hard-coded zstd sites route through the profile, and --long=27 is kept", () => {
  const main = readRepo("src/main.ts");
  assert.doesNotMatch(main, /saveState\("cookCompressLevel", "\d+"\)/, "main.ts cook base level literal");
  assert.doesNotMatch(main, /saveState\("cookDeltaCompressLevel", "\d+"\)/, "main.ts cook delta level literal");
  assert.match(main, /saveState\("cookLongWindow", "27"\)/, "main.ts keeps the cook --long window");
  assert.doesNotMatch(main, /soloToolchainCacheLevel\.trim\(\) \|\| "9"/, "main.ts solo level fallback literal");

  const post = readRepo("src/post.ts");
  assert.doesNotMatch(post, /level: "19"/, "post.ts soldr-mini level literal");
  assert.match(post, /longWindow: 27/, "post.ts keeps the soldr-mini --long window");
  assert.doesNotMatch(post, /cachePayloadWarnBytes \|\| "512MiB"/, "post.ts warn-bytes fallback literal");

  const registry = readRepo("src/lib/cargo-registry-archive.ts");
  assert.doesNotMatch(registry, /"-T0", "-\d+"/, "cargo-registry extras level literal");

  const deferred = readRepo("src/lib/deferred-cook.ts");
  assert.doesNotMatch(deferred, /ZstdLevel: "\d+"/, "deferred-cook level literal");

  for (const file of ["src/main.ts", "src/post.ts", "src/lib/cargo-registry-archive.ts", "src/lib/deferred-cook.ts"]) {
    assert.match(readRepo(file), /local-profile\.js/, `${file} imports the cache profile`);
  }
});

test("deferred cook plan picks zstd -1 under ACT and keeps 9/3 on GitHub", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-local-profile-"));
  try {
    fs.writeFileSync(path.join(workspace, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n", "utf8");
    fs.writeFileSync(path.join(workspace, "Cargo.lock"), "# lock\n", "utf8");
    const planFor = async (env: Record<string, string | undefined>) => buildDeferredCookPlan({
      workspace, runnerOs: "Linux", runnerArch: "X64", githubSha: "0123456789abcdef",
      parentSha: "", targetDir: "target", lockfile: "", flags: "",
      cache: true, deltaCache: true, rustcRelease: "1.94.1",
      soldrVersion: "0.8.1", buildShape: "", env,
    });
    const github = await planFor(GITHUB_ENV);
    const local = await planFor(ACT_ENV);
    assert.equal(github.enabled && github.baseZstdLevel, "9");
    assert.equal(github.enabled && github.deltaZstdLevel, "3");
    assert.equal(local.enabled && local.baseZstdLevel, "1");
    assert.equal(local.enabled && local.deltaZstdLevel, "1");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("post payload policy: no cap and 4GiB notice under ACT, 6GiB/512MiB on GitHub, explicit wins", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveCachePayloadPolicy: (
      inputs: ReturnType<typeof readRawInputs>,
      log: (msg: string) => void,
      env?: Record<string, string | undefined>,
    ) => { warnBytes: number | null; maxBytes: number | null };
  };
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  const empty = readRawInputs({});
  const log = (): void => {};
  assert.deepEqual(
    pick(mod.resolveCachePayloadPolicy(empty, log, GITHUB_ENV)),
    { warnBytes: 512 * MiB, maxBytes: 6 * GiB },
  );
  assert.deepEqual(
    pick(mod.resolveCachePayloadPolicy(empty, log, ACT_ENV)),
    { warnBytes: 4 * GiB, maxBytes: null },
  );
  const explicit = readRawInputs({ "INPUT_CACHE-PAYLOAD-MAX-BYTES": "2GiB", "INPUT_CACHE-PAYLOAD-WARN-BYTES": "1GiB" });
  for (const env of [GITHUB_ENV, ACT_ENV]) {
    assert.deepEqual(pick(mod.resolveCachePayloadPolicy(explicit, log, env)), { warnBytes: 1 * GiB, maxBytes: 2 * GiB });
  }
  // Explicit "0" disables the cap on GitHub too.
  const off = readRawInputs({ "INPUT_CACHE-PAYLOAD-MAX-BYTES": "0" });
  assert.equal(mod.resolveCachePayloadPolicy(off, log, GITHUB_ENV).maxBytes, null);
});

function pick(policy: { warnBytes: number | null; maxBytes: number | null }) {
  return { warnBytes: policy.warnBytes, maxBytes: policy.maxBytes };
}

test("profile log line names the runner kind, the cap and the zstd level", () => {
  assert.equal(
    describeCacheProfile(true, { payloadMaxBytes: "0", zstdLevels: { target: "1", toolchain: "1", cook: "1" } }),
    "setup-soldr: local runner (ACT) cache profile: no payload cap, zstd -1",
  );
  assert.equal(
    describeCacheProfile(false, { payloadMaxBytes: "6GiB", zstdLevels: { target: "3", toolchain: "9", cook: "9" } }),
    "setup-soldr: GitHub-hosted cache profile: payload cap 6GiB, zstd target -3, toolchain -9, cook -9",
  );
  assert.match(readRepo("src/main.ts"), /describeCacheProfile\(/, "main step logs the profile");
});

test("action.yml: the four profile inputs default to empty and document both defaults", () => {
  const action = readRepo("action.yml");
  for (const row of INPUT_TABLE) {
    const block = inputBlock(action, row.knob);
    assert.match(block, /\n    default: ""\s*$/, `${row.knob} default must be ""`);
    assert.match(block, /ACT=true/, `${row.knob} description names ACT=true`);
    assert.ok(block.includes(row.github), `${row.knob} description states GitHub default ${row.github}`);
  }
  const cook = readRepo("cook/action.yml");
  for (const name of ["zstd-level", "delta-zstd-level"]) {
    const block = inputBlock(cook, name);
    assert.match(block, /\n    default: ""\s*$/, `cook ${name} default must be ""`);
    assert.match(block, /ACT=true/, `cook ${name} description names ACT=true`);
  }
});

function inputBlock(yaml: string, name: string): string {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `input ${name} not found`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
}
