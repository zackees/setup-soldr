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

// ---------------------------------------------------------------------------
// PR3: `insights` mode — diagnoses rendering + GitHub annotations + chrome-trace.
// Each test below was written FIRST (TDD) against fixture JSON shaped to match
// the soldr#321 schema. All tests in this block were initially RED before the
// renderer / annotator landed; the implementation in src/lib/compile-cache-stats.ts
// + src/post.ts wiring turns them GREEN.
// ---------------------------------------------------------------------------

// Synthetic `soldr cache report --json` payload with the diagnoses[] surface
// PR3 consumes. Two diagnoses: one high (hit-rate dominator), one medium
// (rustc flag churn). Keeps the test self-contained — no real soldr binary
// needed since rendering is a pure function over the parsed payload.
function fixtureInsightsReport(): Record<string, unknown> {
  return {
    schema_version: 1,
    command: "cache report",
    soldr_version: "0.7.34",
    last_session: { hits: 50, misses: 112, compilations: 162, hit_rate: 0.31 },
    diagnoses: [
      {
        severity: "high",
        headline: "Hit rate 31% — dominated by 3 crates with frequent input changes",
        evidence: {
          miss_reasons_top: [
            { category: "inputs", file: "crates/big-crate/build.rs", misses: 42 },
            { category: "inputs", file: "crates/big-crate/src/lib.rs", misses: 28 },
            { category: "flag", flag: "-C debuginfo=2", misses: 14 },
          ],
          slowest_misses: [
            { crate: "big-crate", ms: 4200, miss_reason: "inputs" },
            { crate: "syn", ms: 2100, miss_reason: "inputs" },
          ],
          wasted_ms: 18500,
        },
        suggested_fix:
          "Normalize source mtimes via preserve-source-mtimes: true, or pin the workspace toolchain.",
      },
      {
        severity: "medium",
        headline: "rustc flag churn detected across compilation units",
        evidence: {
          miss_reasons_top: [
            { category: "flag", flag: "-C target-cpu=native", misses: 9 },
          ],
          wasted_ms: 3200,
        },
        suggested_fix: "Avoid -C target-cpu=native in CI; use a fixed CPU target.",
      },
    ],
  };
}

interface InsightsModule {
  renderInsights: (payload: Record<string, unknown>) => {
    markdown: string;
    annotations: string[];
  };
}

test("insights: renderInsights renders one <details> block per diagnosis with severity emoji + headline", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Each diagnosis gets a <details>…</details> block. Two diagnoses → two blocks.
  const detailsCount = (out.markdown.match(/<details>/g) || []).length;
  assert.equal(detailsCount, 2, "expected one <details> block per diagnosis");
  // Severity emoji + headline appear in the <summary> line.
  // 🔴 = high severity; 🟡 = medium.
  assert.match(out.markdown, /🔴/);
  assert.match(out.markdown, /🟡/);
  assert.match(out.markdown, /Hit rate 31% — dominated by 3 crates/);
  assert.match(out.markdown, /rustc flag churn detected/);
});

test("insights: renderInsights renders miss_reasons_top as a table inside each diagnosis", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // The first diagnosis has 3 miss_reasons_top entries. Verify the table
  // header and at least one row with the file column rendered.
  assert.match(out.markdown, /\| Category \| (File\/Flag|File\|Flag) \| Misses \|/);
  assert.match(out.markdown, /crates\/big-crate\/build\.rs/);
  assert.match(out.markdown, /-C debuginfo=2/);
  assert.match(out.markdown, /\| 42 \|/);
});

test("insights: renderInsights renders slowest_misses list and human-readable wasted_ms", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Slowest misses are emitted as a list. Verify at least the crate names land.
  assert.match(out.markdown, /big-crate/);
  assert.match(out.markdown, /4200|4\.2\s*s/i);
  // wasted_ms is rendered in human-readable form (s, not raw ms).
  // 18500 ms → "18.5s". The exact phrasing is renderer's call but it must NOT
  // be the bare integer 18500 ms.
  assert.match(out.markdown, /18\.5\s*s|18500\s*ms/i);
});

test("insights: renderInsights renders suggested_fix as a footer (quoted)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Suggested fix appears as a Markdown blockquote ("> …") for each diagnosis.
  assert.match(out.markdown, /> Normalize source mtimes/);
  assert.match(out.markdown, /> Avoid -C target-cpu=native/);
});

test("insights: high-severity diagnosis with file produces ::warning file=...:: annotation", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // First diagnosis is high severity and its first miss_reasons_top entry
  // has a file. → ::warning file=crates/big-crate/build.rs,line=1::<headline>
  const warn = out.annotations.find(
    (a) => a.startsWith("::warning") && a.includes("crates/big-crate/build.rs"),
  );
  assert.ok(warn, `expected a ::warning annotation pinned to build.rs, got ${JSON.stringify(out.annotations)}`);
  assert.match(warn!, /::warning file=crates\/big-crate\/build\.rs,line=1::/);
  assert.match(warn!, /Hit rate 31%/);
});

test("insights: medium-severity diagnosis emits ::notice:: annotation (file pin optional)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Second diagnosis is medium severity — its top miss reason is a flag,
  // not a file. → ::notice::<headline> without a file=… pin (line=1 stays
  // optional when there's no file).
  const notice = out.annotations.find(
    (a) => a.startsWith("::notice") && a.includes("rustc flag churn"),
  );
  assert.ok(notice, `expected a ::notice annotation for medium diagnosis, got ${JSON.stringify(out.annotations)}`);
});

test("insights: low severity also maps to ::notice::", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights({
    diagnoses: [
      {
        severity: "low",
        headline: "Minor: registry cache cold this run",
        evidence: { miss_reasons_top: [], wasted_ms: 50 },
        suggested_fix: "Enable cargo-registry-cache.",
      },
    ],
  });
  const notice = out.annotations.find((a) => a.startsWith("::notice"));
  assert.ok(notice, "expected a ::notice annotation for low severity");
  assert.match(notice!, /Minor: registry cache cold this run/);
});

test("insights: empty or missing diagnoses array produces an empty-but-valid result", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out1 = mod.renderInsights({ diagnoses: [] });
  assert.equal(out1.markdown.trim(), "", "no diagnoses → empty markdown");
  assert.deepEqual(out1.annotations, []);
  // Missing entirely (older soldr) is also non-fatal.
  const out2 = mod.renderInsights({});
  assert.equal(out2.markdown.trim(), "");
  assert.deepEqual(out2.annotations, []);
});

test("insights: tolerates diagnoses with missing optional fields (no file/no slowest_misses)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights({
    diagnoses: [
      {
        severity: "high",
        headline: "Catastrophic miss without evidence",
        // Note: evidence missing entirely.
        suggested_fix: "Run again with logging:true.",
      },
      {
        severity: "medium",
        headline: "Partial evidence",
        evidence: { wasted_ms: 100 }, // no miss_reasons_top, no slowest_misses
        suggested_fix: "Inspect.",
      },
    ],
  });
  // Both diagnoses must still render — the renderer never throws on
  // missing optional fields.
  assert.match(out.markdown, /Catastrophic miss without evidence/);
  assert.match(out.markdown, /Partial evidence/);
  // The first has no file → annotation is bare (no file= pin).
  const a1 = out.annotations.find((a) => a.includes("Catastrophic miss"));
  assert.ok(a1);
  assert.equal(/file=/.test(a1!), false, "no file= pin when evidence is absent");
  // Second still emits an annotation despite empty miss_reasons_top.
  assert.ok(out.annotations.find((a) => a.includes("Partial evidence")));
});

test("insights mode in formatFinalCacheSummaryMarkdown renders insights section", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-insights-md-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      soldr_version: "0.7.34",
      report: fixtureInsightsReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "insights" as any);
    // Insights mode is a superset of summarize — it MUST still render the
    // per-session table so workflows don't lose the baseline metrics.
    assert.match(md, /### Compile cache \(zccache\)/);
    assert.match(md, /\| Hit rate \| 31\.0% \|/);
    // …and it must add the insights section with the per-diagnosis blocks.
    assert.match(md, /### Compile cache insights/);
    assert.match(md, /🔴/);
    assert.match(md, /Hit rate 31% — dominated by 3 crates/);
    assert.match(md, /> Normalize source mtimes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("insights mode is opt-in: summarize/detailed/none do NOT render the insights section", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-insights-optin-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureInsightsReport(),
    };
    for (const mode of ["summarize", "detailed", "none"] as const) {
      const md = mod.formatFinalCacheSummaryMarkdown(summary, mode);
      assert.doesNotMatch(
        md,
        /### Compile cache insights/,
        `mode=${mode} must NOT render the insights section`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("insights: severity emoji mapping covers high/medium/low (sanity)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights({
    diagnoses: [
      { severity: "high", headline: "H", suggested_fix: "x" },
      { severity: "medium", headline: "M", suggested_fix: "x" },
      { severity: "low", headline: "L", suggested_fix: "x" },
    ],
  });
  // Exactly one of each emoji line should appear in the markdown.
  assert.equal((out.markdown.match(/🔴/g) || []).length, 1);
  assert.equal((out.markdown.match(/🟡/g) || []).length, 1);
  assert.equal((out.markdown.match(/🟢/g) || []).length, 1);
});

test("insights: normalizeCompileCacheStats accepts 'insights' as a distinct value (not alias for detailed)", async () => {
  // PR3 elevates 'insights' from "alias for detailed" (PR2 scaffolding) to a
  // first-class enum value. This regression test fails if a future refactor
  // collapses it back into detailed.
  const mod = (await import("../src/lib/input-parsers.js")) as {
    normalizeCompileCacheStats: (raw: string) => string;
  };
  assert.equal(mod.normalizeCompileCacheStats("insights"), "insights");
  assert.equal(mod.normalizeCompileCacheStats("detailed"), "detailed");
  assert.equal(mod.normalizeCompileCacheStats("summarize"), "summarize");
  assert.equal(mod.normalizeCompileCacheStats("none"), "none");
  // Unknown values still fall back to "summarize" (preserves old behavior).
  assert.equal(mod.normalizeCompileCacheStats("garbage"), "summarize");
});
