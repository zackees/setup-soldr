import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefreshToolchain,
  shouldSkipRefreshForExactHit,
} from "../src/lib/ensure-rust-toolchain.js";
import { resolveRustupStrategy } from "../src/lib/resolve-setup.js";

test("shouldRefreshToolchain recognizes rolling aliases", () => {
  assert.equal(shouldRefreshToolchain("stable"), true);
  assert.equal(shouldRefreshToolchain("beta"), true);
  assert.equal(shouldRefreshToolchain("nightly"), true);
});

test("shouldRefreshToolchain handles host-suffixed rolling channels", () => {
  assert.equal(shouldRefreshToolchain("stable-x86_64-unknown-linux-gnu"), true);
  assert.equal(shouldRefreshToolchain("nightly-aarch64-apple-darwin"), true);
});

test("shouldRefreshToolchain does not refresh pinned versions", () => {
  assert.equal(shouldRefreshToolchain("1.78.0"), false);
  assert.equal(shouldRefreshToolchain("nightly-2024-04-01"), false);
  assert.equal(shouldRefreshToolchain("beta-2024-05-15"), false);
});

test("shouldRefreshToolchain rejects empty/whitespace input", () => {
  assert.equal(shouldRefreshToolchain(""), false);
  assert.equal(shouldRefreshToolchain("   "), false);
});

test("shouldSkipRefreshForExactHit requires exact match", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", true, "1.78.0"),
    true,
  );
});

test("shouldSkipRefreshForExactHit fails when releases differ", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", true, "1.77.0"),
    false,
  );
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", true, null),
    false,
  );
});

test("shouldSkipRefreshForExactHit requires setup-cache exact hit", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", false, "1.78.0"),
    false,
  );
});

test("shouldSkipRefreshForExactHit requires expected release to be set", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "", true, "1.78.0"),
    false,
  );
});

test("shouldSkipRefreshForExactHit returns false for non-rolling toolchains", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("1.78.0", "1.78.0", true, "1.78.0"),
    false,
  );
});

// --- resolveRustupStrategy (setup-soldr#105) ---

test("resolveRustupStrategy forces managed on darwin when system requested", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "darwin",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "managed");
  assert.equal(warnings.length, 1);
  const warning = warnings[0] ?? "";
  // Warning must explain WHY so users debugging cache-hit changes get a hint.
  assert.match(warning, /macOS/);
  assert.match(warning, /managed/);
  assert.match(warning, /conflict/i);
  assert.match(warning, /105/);
});

test("resolveRustupStrategy leaves managed alone on darwin", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "managed",
    platform: "darwin",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "managed");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy leaves explicit alone on darwin", () => {
  // Explicit means the caller set RUSTUP_HOME — respect that choice.
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "explicit",
    platform: "darwin",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "explicit");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy does not fire on linux", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "linux",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "system");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy does not fire on win32", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "win32",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "system");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy works without a warn callback", () => {
  // The override on darwin must not throw when no warn callback is provided.
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "darwin",
  });
  assert.equal(result, "managed");
});
