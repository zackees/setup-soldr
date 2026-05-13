import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefreshToolchain,
  shouldSkipRefreshForExactHit,
} from "../src/lib/ensure-rust-toolchain.js";

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
