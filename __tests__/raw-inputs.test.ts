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
  });
  assert.equal(r.prebuildDeps, "soldr-cook");
  assert.equal(r.prebuildDepsFlags, "--release --workspace");
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
