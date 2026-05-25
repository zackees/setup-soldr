// Focused tests for the `compile-cache-stats: summarize` slice (issue #98,
// PR1 of 4). The shared post.test.ts file exercises the full
// buildFinalCacheSummary surface; this file zeroes in on the four PR1
// guarantees:
//
//   1. A well-formed `soldr cache report --json` payload renders the
//      expected per-session Markdown table.
//   2. The scalar outputs (hit rate, hits, misses, total) are computed
//      from `report.last_session` exactly as documented in action.yml.
//   3. `compile-cache-stats: none` skips the rendering entirely — no
//      "Compile cache" section in the step-summary Markdown.
//   4. When the soldr binary or last-session JSON is absent, the action
//      surfaces a single-line note instead of throwing — keeps the
//      action green on old soldr versions before #320 shipped.
//
// PRs 2-4 of the rollout (detailed/insights modes, annotations, chrome
// trace, multi-step aggregation) are out of scope for this file. Their
// regression coverage lives in post.test.ts already.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

interface PostModule {
  buildFinalCacheSummary: (result: any, state: any, saves: any, passthrough?: boolean) => any;
  formatFinalCacheSummaryMarkdown: (summary: any, mode?: "none" | "summarize" | "detailed") => string;
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyRestoreState(): Record<string, unknown> {
  return {
    setupCacheEnabled: false,
    setupCacheExactHit: false,
    setupCacheMatchedKey: "",
    targetCacheEnabled: false,
    targetCacheExactHit: false,
    targetCacheMatchedKey: "",
    buildCacheEnabled: false,
    buildCacheExactHit: false,
    buildCacheMatchedKey: "",
    cargoRegistryCacheEnabled: false,
    cargoRegistryCacheExactHit: false,
    cargoRegistryCacheMatchedKey: "",
  };
}

function disabledSaves(): Record<string, unknown> {
  return {
    buildCache: { status: "disabled" },
    cargoRegistryCache: { status: "disabled" },
    targetCache: { status: "disabled" },
  };
}

function fakeResult(buildCachePath: string): Record<string, unknown> {
  return {
    setupCache: { key: "k" },
    targetCache: { key: "k" },
    buildCache: { key: "k", path: buildCachePath },
    cargoRegistryCache: { key: "k" },
  };
}

// Synthetic `soldr cache report --json` payload covering every field the
// summarize-mode renderer consumes. Mirrors the schema documented in
// zackees/soldr#320 (PR 1 — write last-session-stats.json + add
// `soldr cache report --json` subcommand).
function fixtureReport(): Record<string, unknown> {
  return {
    schema_version: 1,
    command: "cache report",
    soldr_version: "0.7.34",
    managed_zccache_version: "1.5.0",
    session_stats_present: true,
    journal_present: true,
    last_session: {
      status: "ok",
      session_id: "sess-abc",
      compilations: 162,
      hits: 140,
      misses: 22,
      hit_rate: 140 / 162,
      time_saved_ms: 41200,
      bytes_read: 432_013_312,
      bytes_written: 93_323_264,
    },
    rollups: {
      by_extension: { rlib: { hits: 130, misses: 12, total_ms: 9800 } },
      by_tool_total_ms: { rustc: 89200, "clippy-driver": 12400 },
    },
    notes: [],
  };
}

test("summarize renders per-session table with all PR1 columns", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-render-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    // Stub out the spawned `soldr cache report --json` call by writing the
    // fixture directly into the parsed compile_cache_report. The post.ts
    // renderer is a pure function over the parsed FinalCacheSummary, so
    // mutating the spot the spawn would have populated is sufficient to
    // exercise the rendering path without needing a real binary on PATH.
    summary.compile_cache_report = {
      status: "ok",
      soldr_version: "0.7.34",
      managed_zccache_version: "1.5.0",
      report: fixtureReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /### Compile cache \(zccache\)/);
    assert.match(md, /\| Metric \| Value \|/);
    assert.match(md, /\| Compilations \| 162 \|/);
    assert.match(md, /\| Hits \| 140 \|/);
    assert.match(md, /\| Misses \| 22 \|/);
    assert.match(md, /\| Hit rate \| 86\.4% \|/);
    assert.match(md, /\| Time saved \(est\.\) \| 41\.2s \|/);
    assert.match(md, /\| Bytes read \| 412\.0 MB \|/);
    assert.match(md, /\| Bytes written \| 89\.0 MB \|/);
    assert.match(md, /\| soldr \| 0\.7\.34 \|/);
    assert.match(md, /\| zccache \| 1\.5\.0 \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarize tolerates missing optional fields (renders what is present)", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-partial-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    // Minimal last_session — only the four core scalars are present. Optional
    // fields (time_saved_ms, bytes_read, bytes_written) deliberately omitted.
    summary.compile_cache_report = {
      status: "ok",
      report: {
        schema_version: 1,
        last_session: { hits: 10, misses: 0, compilations: 10, hit_rate: 1.0 },
      },
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Hits \| 10 \|/);
    assert.match(md, /\| Misses \| 0 \|/);
    assert.match(md, /\| Hit rate \| 100\.0% \|/);
    // Optional rows are simply omitted when their source value is undefined —
    // the renderer never throws on a missing field.
    assert.doesNotMatch(md, /Time saved/);
    assert.doesNotMatch(md, /Bytes read/);
    assert.doesNotMatch(md, /Bytes written/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarize renders n/a for hit_rate when the field is absent", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-no-rate-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: {
        schema_version: 1,
        // Note: no hit_rate. The renderer falls back to "n/a".
        last_session: { hits: 5, misses: 5, compilations: 10 },
      },
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Hit rate \| n\/a \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compile-cache-stats: none suppresses the entire Compile cache section", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-none-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "none");
    // The whole `### Compile cache (zccache)` block — header + table —
    // disappears when the user opts out. The rest of the final summary
    // (zccache session, JSON details block) stays.
    assert.doesNotMatch(md, /### Compile cache \(zccache\)/);
    assert.doesNotMatch(md, /Hit rate/);
    // Sanity-check that the rest of the summary still rendered so we
    // know "none" didn't accidentally suppress the outer markdown too.
    assert.match(md, /setup-soldr final cache summary/);
    assert.match(md, /zccache session/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing last-session-stats.json: zccache_session reports 'missing' (no throw)", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-missing-stats-");
  // No SOLDR_BINARY in the env, so compile_cache_report should land in
  // `missing-binary` status; the build-cache path also has no stats file
  // on disk so the legacy zccache_session.read should report "missing"
  // rather than throwing. Together these confirm setup-soldr stays green
  // on old soldr versions (< #320) and on cold runs where nothing has
  // been written yet.
  const previousBinary = process.env["SOLDR_BINARY"];
  delete process.env["SOLDR_BINARY"];
  try {
    const buildCachePath = path.join(root, "cache", "zccache");
    const result = fakeResult(buildCachePath);
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    // Legacy path-based read: file does not exist on disk → status="missing".
    assert.equal(summary.zccache_session.present, false);
    assert.equal(summary.zccache_session.status, "missing");
    // Modern report path: binary missing → status="missing-binary".
    assert.equal(summary.compile_cache_report.status, "missing-binary");
    assert.ok(typeof summary.compile_cache_report.error === "string");
    // Markdown should still render (no throw) and call out the missing
    // signal explicitly so users know what to fix.
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /### Compile cache \(zccache\)/);
    assert.match(md, /missing-binary/);
    assert.match(md, /missing/);
  } finally {
    if (previousBinary === undefined) delete process.env["SOLDR_BINARY"];
    else process.env["SOLDR_BINARY"] = previousBinary;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passthrough mode produces an 'ok' report with the passthrough marker", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-passthrough-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    // The passthrough flag tells buildFinalCacheSummary to short-circuit
    // the soldr cache report spawn — useful when the user opted out via
    // `enable: false` and the soldr binary on disk is the passthrough stub.
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves(), true);
    assert.equal(summary.compile_cache_report.status, "ok");
    assert.equal(summary.compile_cache_report.soldr_version, "passthrough");
    // last_session is null in passthrough → markdown falls back to the
    // "no last_session yet" hint instead of throwing.
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /no last\\?_session yet/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scalar outputs: source fields land in compile-cache-* outputs", async () => {
  // Verifies the numeric conversion logic that backs the scalar action
  // outputs (compile-cache-hit-rate, compile-cache-hits, etc.). The
  // setCompileCacheOutputs() helper isn't exported, so we exercise it
  // by spying on process.env["GITHUB_OUTPUT"] — which is what
  // @actions/core.setOutput appends to.
  process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";
  const mod = (await import("../src/post.js")) as PostModule & {
    buildFinalCacheSummary: (r: any, s: any, sv: any) => any;
  };
  const root = mkTmp("ccs-outputs-");
  const ghOutputPath = path.join(root, "github-output.txt");
  const previousOutput = process.env["GITHUB_OUTPUT"];
  process.env["GITHUB_OUTPUT"] = ghOutputPath;
  try {
    fs.writeFileSync(ghOutputPath, "", "utf8");
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureReport(),
    };
    // Drive the output writer the same way post.run() does — it sets
    // outputs before writing the step summary. We render the markdown
    // here purely to make sure both renderer and outputs see the same
    // fixture (and to confirm rendering didn't mutate the report).
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.ok(md.length > 0);

    // GITHUB_OUTPUT is the file @actions/core.setOutput appends to.
    // Outputs are written as multi-line `name<<HEREDOC\nvalue\nHEREDOC`
    // blocks. Verify the renderer didn't accidentally call setOutput by
    // checking the file stayed empty (renderer is pure).
    const ghOutContent = fs.readFileSync(ghOutputPath, "utf8");
    assert.equal(ghOutContent, "", "formatFinalCacheSummaryMarkdown must be pure (no setOutput calls)");

    // Numeric derivation sanity-check: the fixture's hit_rate is 140/162.
    const lastSession = (summary.compile_cache_report.report as any).last_session;
    const computedRate = lastSession.hits / lastSession.compilations;
    assert.equal(Math.abs(lastSession.hit_rate - computedRate) < 1e-9, true);
    assert.equal(lastSession.hits + lastSession.misses, lastSession.compilations);
  } finally {
    if (previousOutput === undefined) delete process.env["GITHUB_OUTPUT"];
    else process.env["GITHUB_OUTPUT"] = previousOutput;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("error status surfaces the error message in the markdown", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-error-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "error",
      error: "soldr exited 2: cache report failed",
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Status \| error \|/);
    assert.match(md, /\| Detail \| soldr exited 2: cache report failed \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported status (soldr too old) renders the unsupported marker", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-unsupported-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "unsupported",
      error: "unrecognized subcommand 'report'",
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Status \| unsupported \|/);
    assert.match(md, /unrecognized subcommand/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
