// Tests for src/lib/raw-inputs.ts.
//
// Critical scenario: GitHub Actions runner sets `INPUT_<NAME>` env vars
// where <NAME> preserves dashes (only spaces are converted to underscores).
// So `cache-key-suffix: zccache-demo` lands as `INPUT_CACHE-KEY-SUFFIX`,
// not `INPUT_CACHE_KEY_SUFFIX`. The reader must look up the kebab-case form
// but still accept the underscored form as a back-compat fallback for tests
// that pre-set the underscored name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRawInputs } from "../src/lib/raw-inputs.js";

test("readRawInputs reads kebab-case env (GitHub Actions runner convention)", () => {
  const r = readRawInputs({ "INPUT_CACHE-KEY-SUFFIX": "demo" });
  assert.equal(r.cacheKeySuffix, "demo");
});

test("readRawInputs reads underscored env (legacy/test convention)", () => {
  const r = readRawInputs({ INPUT_CACHE_KEY_SUFFIX: "demo" });
  assert.equal(r.cacheKeySuffix, "demo");
});

test("kebab-case takes precedence over underscored when both set", () => {
  const r = readRawInputs({
    "INPUT_CACHE-KEY-SUFFIX": "kebab",
    INPUT_CACHE_KEY_SUFFIX: "snake",
  });
  assert.equal(r.cacheKeySuffix, "kebab");
});

test("multi-dash kebab inputs resolve correctly", () => {
  const r = readRawInputs({
    "INPUT_TARGET-CACHE-STRIP-DEBUGINFO": "true",
    "INPUT_TARGET-CACHE-INCLUDE-BUILD-SCRIPT-BINARIES": "yes",
  });
  assert.equal(r.targetCacheStripDebuginfo, "true");
  assert.equal(r.targetCacheIncludeBuildScriptBinaries, "yes");
});

test("logging input is exposed on RawInputs", () => {
  const r = readRawInputs({ INPUT_LOGGING: "true" });
  assert.equal(r.logging, "true");
});

test("logging input also works via kebab lookup (single word, same form)", () => {
  const r = readRawInputs({ "INPUT_LOGGING": "true" });
  assert.equal(r.logging, "true");
});

test("missing input defaults to empty string", () => {
  const r = readRawInputs({});
  assert.equal(r.cacheKeySuffix, "");
  assert.equal(r.logging, "");
  assert.equal(r.targetDir, "");
});

test("single-word inputs (no dashes) work unchanged", () => {
  const r = readRawInputs({
    INPUT_DEBUG: "true",
    INPUT_CACHE: "false",
    INPUT_LINKER: "fast",
  });
  assert.equal(r.debugMode, "true");
  assert.equal(r.cache, "false");
  assert.equal(r.linker, "fast");
});

test("journal-print-raw input round-trips through readRawInputs", () => {
  const r = readRawInputs({ "INPUT_JOURNAL-PRINT-RAW": "false" });
  assert.equal(r.journalPrintRaw, "false");
});

test("journal-print-raw defaults to empty when unset", () => {
  const r = readRawInputs({});
  assert.equal(r.journalPrintRaw, "");
});

test("prebuild-deps inputs round-trip through readRawInputs", () => {
  const r = readRawInputs({
    "INPUT_PREBUILD-DEPS": "soldr-cook",
    "INPUT_PREBUILD-DEPS-FLAGS": "--release --workspace",
    "INPUT_PREBUILD-DEPS-DELTA-CACHE": "false",
  });
  assert.equal(r.prebuildDeps, "soldr-cook");
  assert.equal(r.prebuildDepsFlags, "--release --workspace");
  assert.equal(r.prebuildDepsDeltaCache, "false");
});

test("zccache seed strict input round-trips through readRawInputs", () => {
  const r = readRawInputs({ "INPUT_ZCCACHE-SEED-STRICT": "true" });
  assert.equal(r.zccacheSeedStrict, "true");
});

test("dylint cache inputs round-trip through readRawInputs", () => {
  const r = readRawInputs({
    "INPUT_DYLINT-CACHE": "true",
    "INPUT_DYLINT-TOOLCHAIN": "nightly-2026-03-26",
    "INPUT_DYLINT-DRIVER-REV": "4bd91ce",
    "INPUT_CARGO-DYLINT-VERSION": "5.0.0",
    "INPUT_DYLINT-LINK-VERSION": "5.0.0",
    "INPUT_DYLINT-CACHE-PATHS": "cache/dylint",
  });
  assert.equal(r.dylintCache, "true");
  assert.equal(r.dylintToolchain, "nightly-2026-03-26");
  assert.equal(r.dylintDriverRev, "4bd91ce");
  assert.equal(r.cargoDylintVersion, "5.0.0");
  assert.equal(r.dylintLinkVersion, "5.0.0");
  assert.equal(r.dylintCachePaths, "cache/dylint");
});

test("dylint mode inputs round-trip and remain empty when omitted", () => {
  const enabled = readRawInputs({
    INPUT_DYLINT: "true",
    "INPUT_DYLINT-FOUNDATION-CACHE": "true",
    "INPUT_DYLINT-OUTPUT-CACHE": "true",
  });
  assert.equal(enabled.dylint, "true");
  assert.equal(enabled.dylintFoundationCache, "true");
  assert.equal(enabled.dylintOutputCache, "true");
  const omitted = readRawInputs({});
  assert.equal(omitted.dylint, "");
});

test("timestamp-format input round-trips through readRawInputs", () => {
  const r = readRawInputs({ "INPUT_TIMESTAMP-FORMAT": "seconds" });
  assert.equal(r.timestampFormat, "seconds");
});

test("timestamp-format defaults to empty when unset", () => {
  const r = readRawInputs({});
  assert.equal(r.timestampFormat, "");
});

test("cache payload audit inputs round-trip through readRawInputs", () => {
  const r = readRawInputs({
    "INPUT_CACHE-PAYLOAD-WARN-BYTES": "1GiB",
    "INPUT_CACHE-PAYLOAD-MAX-BYTES": "4GiB",
    "INPUT_CACHE-PAYLOAD-OVERSIZE-ACTION": "fail",
    "INPUT_CACHE-PAYLOAD-TOP-N": "25",
  });
  assert.equal(r.cachePayloadWarnBytes, "1GiB");
  assert.equal(r.cachePayloadMaxBytes, "4GiB");
  assert.equal(r.cachePayloadOversizeAction, "fail");
  assert.equal(r.cachePayloadTopN, "25");
});
