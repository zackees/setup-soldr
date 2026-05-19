import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildOutputs,
  detectMuslCcEnv,
  detectUserLinkerEnv,
  readRawInputs,
  resolveSetup,
} from "../src/lib/resolve-setup.js";
import { createLogger } from "../src/lib/log-utils.js";
import type { ActionContext, RawInputs, ResolveResult } from "../src/lib/types.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeWorkspace(opts: {
  withLockfile?: boolean;
  lockfileContents?: string;
  files?: Record<string, string>;
} = {}): { root: string; workspace: string; runnerTemp: string } {
  const root = mkTmp("setup-soldr-tests-");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runnerTemp, { recursive: true });
  if (opts.withLockfile !== false) {
    fs.writeFileSync(
      path.join(workspace, "Cargo.lock"),
      opts.lockfileContents ?? "# test lockfile\n",
      "utf8",
    );
  }
  for (const [relative, contents] of Object.entries(opts.files ?? {})) {
    const filePath = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
  }
  return { root, workspace, runnerTemp };
}

function makeContext(root: string, workspace: string, runnerTemp: string): ActionContext {
  const env: Record<string, string | undefined> = {
    ACTION_WORKSPACE: workspace,
    ACTION_OS: "Linux",
    ACTION_ARCH: "X64",
    RUNNER_TEMP: runnerTemp,
    GITHUB_SHA: "0123456789abcdef",
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    CARGO_HOME: path.join(root, "cargo-home"),
    RUSTUP_HOME: path.join(root, "rustup-home"),
    INPUT_VERSION: "0.7.11",
    INPUT_TIMESTAMPS: "false",
    INPUT_TOOLCHAIN_FILE: "",
  };
  return {
    env,
    workspace,
    runnerTemp,
    runnerOs: "Linux",
    runnerArch: "X64",
    githubSha: "0123456789abcdef",
    githubToken: "",
    parentSha: "",
    logger: createLogger(env),
  };
}

function withInputs(env: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string | undefined> {
  return { ...env, ...extra };
}

async function run(
  rootOpts: Parameters<typeof makeWorkspace>[0] = {},
  extraEnv: Record<string, string> = {},
  override?: () => Promise<boolean>,
): Promise<{ result: ResolveResult; outputs: Record<string, string> }> {
  const { root, workspace, runnerTemp } = makeWorkspace(rootOpts);
  const ctx = makeContext(root, workspace, runnerTemp);
  ctx.env = withInputs(ctx.env, extraEnv);
  const inputs: RawInputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: override ?? (async () => false),
  });
  return { result, outputs: buildOutputs(result) };
}

// --- pruning inputs ---

test("defaults do not export pruning env vars", async () => {
  const { result } = await run();
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], undefined);
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"], undefined);
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"], undefined);
});

test("empty pruning inputs do not export env vars", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "",
    INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL: "",
    INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES: "",
  });
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], undefined);
});

test("pruning inputs true normalize to literal 'true'", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "true",
    INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL: "yes",
    INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES: "1",
  });
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], "true");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"], "true");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"], "true");
});

test("pruning inputs false normalize to literal 'false'", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "false",
    INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL: "0",
    INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES: "off",
  });
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], "false");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"], "false");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"], "false");
});

test("invalid pruning value rejects with clear error", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "maybe" }),
    /invalid target-cache-strip-debuginfo/,
  );
});

// --- compression ---

test("default compression codec is zstd", async () => {
  const { result, outputs } = await run();
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_COMPRESS"], "zstd");
  assert.equal(outputs["target_cache_compress"], "zstd");
});

test("default compression level is 3", async () => {
  const { result, outputs } = await run();
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_COMPRESS_LEVEL"], "3");
  assert.equal(outputs["target_cache_compress_level"], "3");
});

test("explicit codec propagates", async () => {
  for (const codec of ["auto", "zstd", "none"]) {
    const { outputs } = await run({}, { INPUT_TARGET_CACHE_COMPRESS: codec });
    assert.equal(outputs["target_cache_compress"], codec);
  }
});

test("invalid codec rejected", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_COMPRESS: "lz4" }),
    /invalid target-cache-compress/,
  );
});

test("invalid compress level rejected", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_COMPRESS_LEVEL: "fast" }),
    /invalid target-cache-compress-level/,
  );
});

test("compression inputs do not change cache keys", async () => {
  // Both runs must use the same workspace so target_cache_path (which feeds
  // the target_shape hash) is identical between the baseline and the
  // run-with-extra-inputs.
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const baseCtx = makeContext(root, workspace, runnerTemp);
  const inputsBase = readRawInputs(baseCtx.env);
  const r1 = await resolveSetup(baseCtx, inputsBase, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const ctx2 = makeContext(root, workspace, runnerTemp);
  ctx2.env = withInputs(ctx2.env, {
    INPUT_TARGET_CACHE_COMPRESS: "none",
    INPUT_TARGET_CACHE_COMPRESS_LEVEL: "9",
  });
  const inputs2 = readRawInputs(ctx2.env);
  const r2 = await resolveSetup(ctx2, inputs2, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const a = buildOutputs(r1);
  const b = buildOutputs(r2);
  assert.equal(a["cache_key"], b["cache_key"]);
  assert.equal(a["target_cache_key"], b["target_cache_key"]);
});

// --- profile ---

test("default target-cache-profile is thin-v1", async () => {
  const { outputs } = await run();
  assert.equal(outputs["target_cache_profile"], "thin-v1");
});

test("explicit target-cache-profile passes through", async () => {
  const { outputs } = await run({}, { INPUT_TARGET_CACHE_PROFILE: "thin-v2" });
  assert.equal(outputs["target_cache_profile"], "thin-v2");
});

test("invalid target-cache-profile rejected", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_PROFILE: "fat" }),
    /invalid target-cache-profile/,
  );
});

// --- build cache mode ---

test("default build cache mode resolves to 'once', soldr-mode 'full'", async () => {
  const { result, outputs } = await run();
  assert.equal(outputs["build_cache_mode"], "once");
  assert.equal(result.envExports["SETUP_SOLDR_BUILD_CACHE_MODE"], "once");
  assert.equal(result.envExports["SOLDR_BUILD_CACHE_MODE"], "full");
});

test("thin build cache mode requires Cargo.lock", async () => {
  const { result, outputs } = await run(
    { withLockfile: false },
    { INPUT_BUILD_CACHE_MODE: "thin" },
  );
  assert.equal(outputs["target_lockfile_hash"], "no-lock");
  assert.equal(outputs["target_cache_enabled"], "false");
  assert.equal(outputs["target_cache_mode"], "off");
  assert.equal(outputs["target_cache_budget_bytes"], "");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_MODE"], "off");
});

test("full build cache mode restores target tree + bundle", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "full" });
  const lines = (outputs["target_cache_paths"] ?? "").split("\n");
  assert.equal(lines.length, 2);
  assert.equal(outputs["target_cache_mode"], "full");
});

test("legacy hot -> thin translation", async () => {
  const { outputs } = await run({}, { INPUT_TARGET_CACHE_MODE: "hot" });
  assert.equal(outputs["build_cache_mode"], "thin");
});

test("legacy off disables target cache", async () => {
  const { result, outputs } = await run({}, { INPUT_TARGET_CACHE_MODE: "off" });
  assert.equal(outputs["build_cache_mode"], "once");
  assert.equal(outputs["target_cache_enabled"], "false");
  assert.equal(outputs["target_cache_mode"], "off");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_MODE"], "off");
});

test("explicit version is normalized for cache keying", async () => {
  const { outputs: a } = await run({}, { INPUT_VERSION: "0.7.11" });
  const { outputs: b } = await run({}, { INPUT_VERSION: "v0.7.11" });
  assert.equal(a["soldr_version_resolved"], "v0.7.11");
  assert.equal(b["soldr_version_resolved"], "v0.7.11");
  assert.equal(a["cache_key"], b["cache_key"]);
});

test("latest release lookup uses token input for GitHub API auth", async () => {
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = (async (_url: unknown, init?: { headers?: unknown }) => {
    const headers = init?.headers as Record<string, string> | undefined;
    authorization = headers?.["Authorization"] ?? "";
    return new Response(JSON.stringify({ tag_name: "v0.7.12" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { root, workspace, runnerTemp } = makeWorkspace({});
    const ctx = makeContext(root, workspace, runnerTemp);
    ctx.env = withInputs(ctx.env, {
      INPUT_VERSION: "latest",
      INPUT_TOKEN: "input-token",
    });
    const inputs = readRawInputs(ctx.env);
    const result = await resolveSetup(ctx, inputs, {
      systemRustupOverride: async () => false,
    });

    assert.equal(result.soldrVersionResolved, "v0.7.12");
    assert.equal(authorization, "Bearer input-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source ref changes setup cache key", async () => {
  const { outputs: base } = await run({}, { INPUT_REPO: "zackees/soldr" });
  const { outputs: branch } = await run({}, {
    INPUT_REPO: "zackees/soldr",
    INPUT_REF: "feature-x",
  });
  assert.notEqual(base["cache_key"], branch["cache_key"]);
});

// --- lockfile-only restore key ---

test("lockfile prefix emitted for once mode", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "once" });
  const prefix = outputs["target_cache_restore_key_lockfile"] ?? "";
  assert.match(prefix, /^setup-soldr-targetcache-once-v1-linux-x64-/);
  assert.ok(prefix.endsWith("-"));
});

test("lockfile prefix emitted for full mode", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "full" });
  const prefix = outputs["target_cache_restore_key_lockfile"] ?? "";
  assert.match(prefix, /^setup-soldr-targetcache-full-v1-linux-x64-/);
});

test("lockfile prefix stable across manifest changes", async () => {
  const { outputs: a } = await run({
    files: { "Cargo.toml": "[package]\nname='a'\nversion='0.1.0'\n" },
  }, { INPUT_BUILD_CACHE_MODE: "once" });
  const { outputs: b } = await run({
    files: { "Cargo.toml": "[package]\nname='a'\nversion='0.1.0'\n[[bin]]\nname='x'\npath='src/main.rs'\n" },
  }, { INPUT_BUILD_CACHE_MODE: "once" });
  assert.notEqual(a["target_cache_restore_key_lock"], b["target_cache_restore_key_lock"]);
  assert.equal(
    a["target_cache_restore_key_lockfile"],
    b["target_cache_restore_key_lockfile"],
  );
});

test("lockfile prefix changes when lockfile contents change", async () => {
  const { outputs: a } = await run({ lockfileContents: "# baseline\n" }, { INPUT_BUILD_CACHE_MODE: "once" });
  const { outputs: b } = await run({ lockfileContents: "# different\n" }, { INPUT_BUILD_CACHE_MODE: "once" });
  assert.notEqual(
    a["target_cache_restore_key_lockfile"],
    b["target_cache_restore_key_lockfile"],
  );
});

test("lockfile prefix empty when target cache disabled", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE: "false" });
  assert.equal(outputs["target_cache_enabled"], "false");
  assert.equal(outputs["target_cache_restore_key_lock"], "");
  assert.equal(outputs["target_cache_restore_key_lockfile"], "");
});

test("lockfile prefix includes cache-key suffix fragment", async () => {
  const { outputs } = await run({}, {
    INPUT_BUILD_CACHE_MODE: "once",
    INPUT_CACHE_KEY_SUFFIX: "myjob",
  });
  const prefix = outputs["target_cache_restore_key_lockfile"] ?? "";
  assert.ok(prefix.endsWith("-myjob-"));
});

test("target_cache_key always derived from narrow lock prefix + SHA", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "once" });
  const key = outputs["target_cache_key"] ?? "";
  const narrow = outputs["target_cache_restore_key_lock"] ?? "";
  assert.ok(key.startsWith(narrow), `expected ${key} to start with ${narrow}`);
  assert.ok(key.endsWith("0123456789abcdef"));
});

// --- system rustup layout ---

test("setup_cache_layout reflects managed rustup path by default", async () => {
  // Skip explicit RUSTUP_HOME so managed path is chosen.
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const ctx = makeContext(root, workspace, runnerTemp);
  delete ctx.env["RUSTUP_HOME"];
  const inputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  assert.equal(result.setupCache.layout, "bin+soldr-bin+rustup");
  assert.equal(result.rustupStrategy, "managed");
});

test("system rustup match makes layout bin+soldr-bin", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const ctx = makeContext(root, workspace, runnerTemp);
  delete ctx.env["RUSTUP_HOME"];
  const inputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => true,
  });
  assert.equal(result.setupCache.layout, "bin+soldr-bin");
  assert.equal(result.rustupStrategy, "system");
});

test("layout switch alters cache key", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const ctx = makeContext(root, workspace, runnerTemp);
  delete ctx.env["RUSTUP_HOME"];
  const inputs = readRawInputs(ctx.env);
  const r1 = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const r2 = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => true,
  });
  assert.notEqual(r1.setupCache.key, r2.setupCache.key);
});

// --- linker ---

async function runCapturingWarnings(
  extraEnv: Record<string, string> = {},
): Promise<{ result: ResolveResult; warnings: string[]; infos: string[] }> {
  const { root, workspace, runnerTemp } = makeWorkspace();
  const ctx = makeContext(root, workspace, runnerTemp);
  ctx.env = withInputs(ctx.env, extraEnv);
  const warnings: string[] = [];
  const infos: string[] = [];
  ctx.logger = {
    info: (msg) => infos.push(msg),
    warning: (msg) => warnings.push(msg),
    error: () => {},
    debug: () => {},
    log: () => {},
  };
  const inputs: RawInputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  return { result, warnings, infos };
}

test("linker default exports SOLDR_LINKER=fast and warns", async () => {
  const { result, warnings } = await runCapturingWarnings();
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
  assert.equal(
    warnings.some((m) => m.includes("SOLDR_LINKER=fast") && m.includes("platform-default")),
    true,
    `expected linker warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("linker platform-default omits SOLDR_LINKER and does not warn", async () => {
  const { result, warnings } = await runCapturingWarnings({ INPUT_LINKER: "platform-default" });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
  assert.equal(warnings.some((m) => m.includes("SOLDR_LINKER")), false);
});

test("linker explicit value passes through verbatim without warning", async () => {
  const { result, warnings } = await runCapturingWarnings({ INPUT_LINKER: "rust-lld" });
  assert.equal(result.envExports["SOLDR_LINKER"], "rust-lld");
  assert.equal(warnings.some((m) => m.includes("SOLDR_LINKER")), false);
});

test("linker explicit fast passes through without warning", async () => {
  const { result, warnings } = await runCapturingWarnings({ INPUT_LINKER: "fast" });
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
  assert.equal(warnings.some((m) => m.includes("SOLDR_LINKER")), false);
});

// --- compile-priority ---

test("compile-priority defaults to high via action.yml", async () => {
  const { result } = await run({}, { INPUT_COMPILE_PRIORITY: "high" });
  assert.equal(result.envExports["ZCCACHE_COMPILE_PRIORITY"], "high");
});

test("compile-priority explicit low passes through verbatim", async () => {
  const { result } = await run({}, { INPUT_COMPILE_PRIORITY: "low" });
  assert.equal(result.envExports["ZCCACHE_COMPILE_PRIORITY"], "low");
});

test("compile-priority empty string skips export so zccache uses its native default", async () => {
  const { result } = await run({}, { INPUT_COMPILE_PRIORITY: "" });
  assert.equal(result.envExports["ZCCACHE_COMPILE_PRIORITY"], undefined);
});

// --- jobserver env deny list ---

test("CARGO_MAKEFLAGS / MAKEFLAGS are never exported", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "true",
  });
  assert.equal(result.envExports["CARGO_MAKEFLAGS"], undefined);
  assert.equal(result.envExports["MAKEFLAGS"], undefined);
});

// --- readRawInputs ---

test("readRawInputs maps INPUT_* env vars by name", () => {
  const inputs = readRawInputs({
    INPUT_VERSION: "0.7.11",
    INPUT_REPO: "zackees/soldr",
    INPUT_TARGET_CACHE_COMPRESS: "zstd",
    INPUT_CARGO_REGISTRY_CACHE: "true",
    INPUT_LINKER: "fast",
  });
  assert.equal(inputs.version, "0.7.11");
  assert.equal(inputs.repo, "zackees/soldr");
  assert.equal(inputs.targetCacheCompress, "zstd");
  assert.equal(inputs.cargoRegistryCache, "true");
  assert.equal(inputs.cacheDir, "");
  assert.equal(inputs.linker, "fast");
});

// --- linker input (validation + alias semantics) ---

test("linker 'default' opts out and does not export SOLDR_LINKER", async () => {
  const { result } = await run({}, { INPUT_LINKER: "default" });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
});

test("linker valid non-opt-out values export SOLDR_LINKER", async () => {
  for (const value of ["ld", "mold", "rust-lld", "fast"]) {
    const { result } = await run({}, { INPUT_LINKER: value });
    assert.equal(result.envExports["SOLDR_LINKER"], value, `linker=${value}`);
  }
});

test("linker invalid value throws with helpful message", async () => {
  await assert.rejects(
    () => run({}, { INPUT_LINKER: "garbage" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /invalid 'linker' input/);
      return true;
    },
  );
});

// --- linker default deferral when user has cross-compile env preset (issue #108) ---

test("linker default defers to user-set CARGO_TARGET_<TRIPLE>_LINKER and skips SOLDR_LINKER=fast", async () => {
  const { result, warnings, infos } = await runCapturingWarnings({
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
  assert.equal(
    warnings.some((m) => m.includes("SOLDR_LINKER")),
    false,
    `unexpected linker warning: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    infos.some(
      (m) =>
        m.includes("deferring to user-set") &&
        m.includes("CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc"),
    ),
    `expected deferral info, got: ${JSON.stringify(infos)}`,
  );
});

test("linker default defers when only CARGO_TARGET_<TRIPLE>_RUSTFLAGS is preset", async () => {
  const { result, infos } = await runCapturingWarnings({
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-C link-arg=-fuse-ld=ld",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
  assert.ok(
    infos.some((m) =>
      m.includes("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C link-arg=-fuse-ld=ld"),
    ),
    `expected deferral info, got: ${JSON.stringify(infos)}`,
  );
});

test("linker explicit 'fast' still injects even when CARGO_TARGET_<TRIPLE>_LINKER is preset", async () => {
  const { result } = await runCapturingWarnings({
    INPUT_LINKER: "fast",
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
});

test("linker default with empty CARGO_TARGET_<TRIPLE>_LINKER does not defer", async () => {
  const { result, warnings } = await runCapturingWarnings({
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
  assert.ok(warnings.some((m) => m.includes("SOLDR_LINKER=fast")));
});

// --- detectMuslCcEnv (cc-rs cross-compile env autodetect) ---

test("detectMuslCcEnv picks up triple from CARGO_BUILD_TARGET and exports CC/CXX/AR", () => {
  const found = new Set([
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
    "aarch64-unknown-linux-musl-ar",
  ]);
  const hits = detectMuslCcEnv(
    { PATH: "/opt/cross/bin", CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl" },
    {
      findOnPath: (cmd) => (found.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.triple, "aarch64-unknown-linux-musl");
  assert.deepEqual(hits[0]!.exports, {
    CC_aarch64_unknown_linux_musl: "aarch64-unknown-linux-musl-gcc",
    CXX_aarch64_unknown_linux_musl: "aarch64-unknown-linux-musl-g++",
    AR_aarch64_unknown_linux_musl: "aarch64-unknown-linux-musl-ar",
  });
});

test("detectMuslCcEnv picks up triple from CARGO_TARGET_<TRIPLE>_LINKER preset", () => {
  const found = new Set([
    "x86_64-unknown-linux-musl-gcc",
    "x86_64-unknown-linux-musl-g++",
    "x86_64-unknown-linux-musl-ar",
  ]);
  const hits = detectMuslCcEnv(
    {
      PATH: "/opt/cross/bin",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: "x86_64-unknown-linux-musl-gcc",
    },
    {
      findOnPath: (cmd) => (found.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.triple, "x86_64-unknown-linux-musl");
});

test("detectMuslCcEnv discovers triples by PATH scan when no env hints exist", () => {
  const hits = detectMuslCcEnv(
    { PATH: "/opt/cross/bin" },
    {
      findOnPath: (cmd) => {
        if (cmd.endsWith("-gcc") || cmd.endsWith("-g++") || cmd.endsWith("-ar")) {
          return `/opt/cross/bin/${cmd}`;
        }
        return null;
      },
      readDir: (dir) =>
        dir === "/opt/cross/bin"
          ? [
              "aarch64-unknown-linux-musl-gcc",
              "aarch64-unknown-linux-musl-g++",
              "aarch64-unknown-linux-musl-ar",
              "ls",
            ]
          : [],
    },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.triple, "aarch64-unknown-linux-musl");
});

test("detectMuslCcEnv skips triple when user has already set CC_<triple>", () => {
  const found = new Set([
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
    "aarch64-unknown-linux-musl-ar",
  ]);
  const hits = detectMuslCcEnv(
    {
      PATH: "/opt/cross/bin",
      CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl",
      CC_aarch64_unknown_linux_musl: "/custom/path/cc",
    },
    {
      findOnPath: (cmd) => (found.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.deepEqual(hits, []);
});

test("detectMuslCcEnv ignores non-musl triples (e.g. linux-gnu)", () => {
  const hits = detectMuslCcEnv(
    {
      PATH: "/usr/bin",
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
    },
    {
      findOnPath: () => "/usr/bin/aarch64-linux-gnu-gcc",
      readDir: () => [],
    },
  );
  assert.deepEqual(hits, []);
});

test("detectMuslCcEnv skips triple when a required binary (ar) is missing on PATH", () => {
  const present = new Set([
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
  ]);
  const hits = detectMuslCcEnv(
    { PATH: "/opt/cross/bin", CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl" },
    {
      findOnPath: (cmd) => (present.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.deepEqual(hits, []);
});

test("resolveSetup exports cc-rs musl env and emits a yellow warning when binaries are on PATH", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace();
  const fakeBin = path.join(root, "cross-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of [
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
    "aarch64-unknown-linux-musl-ar",
  ]) {
    fs.writeFileSync(path.join(fakeBin, name), "", "utf8");
  }
  const ctx = makeContext(root, workspace, runnerTemp);
  ctx.env = withInputs(ctx.env, {
    CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl",
    PATH: fakeBin,
  });
  const warnings: string[] = [];
  ctx.logger = {
    info: () => {},
    warning: (msg) => warnings.push(msg),
    error: () => {},
    debug: () => {},
    log: () => {},
  };
  const inputs: RawInputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  assert.equal(
    result.envExports["CC_aarch64_unknown_linux_musl"],
    "aarch64-unknown-linux-musl-gcc",
  );
  assert.equal(
    result.envExports["CXX_aarch64_unknown_linux_musl"],
    "aarch64-unknown-linux-musl-g++",
  );
  assert.equal(
    result.envExports["AR_aarch64_unknown_linux_musl"],
    "aarch64-unknown-linux-musl-ar",
  );
  assert.ok(
    warnings.some(
      (m) =>
        m.includes("auto-exporting cc-rs cross-compile env") &&
        m.includes("aarch64-unknown-linux-musl"),
    ),
    `expected musl cc-rs warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("detectUserLinkerEnv returns matching CARGO_TARGET_<TRIPLE> vars sorted", () => {
  const env = {
    HOME: "/home/x",
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-C link-arg=-fuse-ld=ld",
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
    CARGO_TARGET_DIR: "/tmp/target",
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_CC: "aarch64-linux-gnu-gcc",
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "",
  };
  assert.deepEqual(detectUserLinkerEnv(env), [
    "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc",
    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C link-arg=-fuse-ld=ld",
  ]);
});

// --- enable input (passthrough mode) ---

test("enable defaults to true and soldrPath ends in soldr/soldr.exe", async () => {
  const { result, outputs } = await run();
  assert.equal(result.enabled, true);
  assert.equal(outputs["enabled"], "true");
  const expectedName = process.platform === "win32" ? "soldr.exe" : "soldr";
  assert.ok(
    result.soldrPath.endsWith(expectedName),
    `expected soldrPath to end in ${expectedName}, got ${result.soldrPath}`,
  );
});

test("enable=true is accepted and behaves as default", async () => {
  const { result } = await run({}, { INPUT_ENABLE: "true" });
  assert.equal(result.enabled, true);
});

test("enable=false flips enabled to false and points soldrPath at the stub file", async () => {
  const { result, outputs } = await run({}, { INPUT_ENABLE: "false" });
  assert.equal(result.enabled, false);
  assert.equal(outputs["enabled"], "false");
  const expectedName = process.platform === "win32" ? "soldr.cmd" : "soldr";
  assert.ok(
    result.soldrPath.endsWith(expectedName),
    `expected soldrPath to end in ${expectedName}, got ${result.soldrPath}`,
  );
});

test("enable invalid value rejects with helpful message", async () => {
  await assert.rejects(
    () => run({}, { INPUT_ENABLE: "maybe" }),
    /invalid 'enable' input/,
  );
});

// --- cache-shutdown-on-idle input ---

test("cache-shutdown-on-idle defaults to null (no override)", async () => {
  const { result } = await run();
  assert.equal(result.cacheShutdownOnIdleSeconds, null);
  assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], undefined);
  assert.equal(result.envExports["SCCACHE_IDLE_TIMEOUT"], undefined);
});

test("cache-shutdown-on-idle bare integer parsed as seconds", async () => {
  const { result } = await run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: "30" });
  assert.equal(result.cacheShutdownOnIdleSeconds, 30);
  assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], "30");
  assert.equal(result.envExports["SCCACHE_IDLE_TIMEOUT"], "30");
});

test("cache-shutdown-on-idle accepts s/m/h suffixes", async () => {
  const cases: Array<[string, number]> = [
    ["30s", 30],
    ["2m", 120],
    ["1h", 3600],
  ];
  for (const [raw, expected] of cases) {
    const { result } = await run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: raw });
    assert.equal(result.cacheShutdownOnIdleSeconds, expected, `input=${raw}`);
    assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], String(expected));
    assert.equal(result.envExports["SCCACHE_IDLE_TIMEOUT"], String(expected));
  }
});

test("cache-shutdown-on-idle '0'/'off'/'false' disable the override", async () => {
  for (const raw of ["0", "off", "false", "no"]) {
    const { result } = await run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: raw });
    assert.equal(result.cacheShutdownOnIdleSeconds, null, `input=${raw}`);
    assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], undefined);
  }
});

test("cache-shutdown-on-idle rejects malformed values", async () => {
  await assert.rejects(
    () => run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: "thirty" }),
    /invalid 'cache-shutdown-on-idle' input/,
  );
  await assert.rejects(
    () => run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: "30sec" }),
    /invalid 'cache-shutdown-on-idle' input/,
  );
});
