import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseShimBypass } from "../src/lib/shim-bypass-check.js";

// All tests pin platform + pathSep explicitly so they pass identically on
// Windows, macOS, and Linux CI runners. The module's defaults read
// process.platform; we override to keep tests deterministic.

const POSIX_SHIM_DIR = "/runner/.setup-soldr/shims";
const WIN_SHIM_DIR = "C:\\runner\\.setup-soldr\\shims";

test("shims disabled -> no warnings even with overrides", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: false,
    shimDir: POSIX_SHIM_DIR,
    path: "/usr/local/bin:/usr/bin:/bin",
    cargoEnv: "/home/runner/.cargo/bin/cargo",
    rustcEnv: "/home/runner/.rustup/toolchains/stable/bin/rustc",
    rustcWrapperEnv: "/opt/sccache/bin/sccache",
    platform: "linux",
    pathSep: ":",
  });
  assert.deepEqual(warnings, []);
});

test("shims enabled + PATH starts with shim dir + no env overrides -> no warnings", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/local/bin:/usr/bin`,
    platform: "linux",
    pathSep: ":",
  });
  assert.deepEqual(warnings, []);
});

test("shims enabled + CARGO set to non-shim absolute path -> warning", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/bin`,
    cargoEnv: "/home/runner/.cargo/bin/cargo",
    platform: "linux",
    pathSep: ":",
  });
  assert.equal(warnings.length, 1);
  const msg = warnings[0]!;
  assert.match(msg, /CARGO env var is set to \/home\/runner\/\.cargo\/bin\/cargo/);
  assert.match(msg, /bypass zccache\/soldr/);
  assert.match(msg, /Unset CARGO/);
});

test("shims enabled + RUSTC set to non-shim absolute path -> warning", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/bin`,
    rustcEnv: "/home/runner/.rustup/toolchains/1.94.1/bin/rustc",
    platform: "linux",
    pathSep: ":",
  });
  assert.equal(warnings.length, 1);
  const msg = warnings[0]!;
  assert.match(msg, /RUSTC env var is set to/);
  assert.match(msg, /\.rustup\/toolchains\/1\.94\.1\/bin\/rustc/);
  assert.match(msg, /bypass zccache\/soldr/);
});

test("shims enabled + RUSTC_WRAPPER set to a non-soldr non-zccache binary -> warning", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/bin`,
    rustcWrapperEnv: "/opt/sccache/bin/sccache",
    soldrBinary: "/runner/.setup-soldr/bin/soldr",
    platform: "linux",
    pathSep: ":",
  });
  assert.equal(warnings.length, 1);
  const msg = warnings[0]!;
  assert.match(msg, /RUSTC_WRAPPER is set to \/opt\/sccache\/bin\/sccache/);
  assert.match(msg, /competing wrapper/);
  assert.match(msg, /Unset RUSTC_WRAPPER/);
});

test("shims enabled + RUSTC_WRAPPER set to soldr binary -> no warning", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/bin`,
    rustcWrapperEnv: "/runner/.setup-soldr/bin/soldr",
    soldrBinary: "/runner/.setup-soldr/bin/soldr",
    platform: "linux",
    pathSep: ":",
  });
  assert.deepEqual(warnings, []);
});

test("shims enabled + RUSTC_WRAPPER set to a zccache binary by basename -> no warning", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/bin`,
    rustcWrapperEnv: "/runner/.soldr/bin/zccache",
    soldrBinary: "/runner/.setup-soldr/bin/soldr",
    platform: "linux",
    pathSep: ":",
  });
  assert.deepEqual(warnings, []);
});

test("shims enabled + ~/.cargo/bin ahead of shim dir on PATH -> warning", () => {
  const cargoBin = "/home/runner/.cargo/bin";
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${cargoBin}:${POSIX_SHIM_DIR}:/usr/bin`,
    platform: "linux",
    pathSep: ":",
  });
  assert.equal(warnings.length, 1);
  const msg = warnings[0]!;
  assert.match(msg, /PATH has 1 entry ahead of the shim directory/);
  assert.match(msg, /first offender: \/home\/runner\/\.cargo\/bin/);
  assert.match(msg, /Move the shim directory to the front of PATH/);
});

test("shims enabled + shim dir missing from PATH entirely -> warning", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: "/usr/local/bin:/usr/bin:/bin",
    platform: "linux",
    pathSep: ":",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /shim directory .* is not present on PATH/);
});

test("shims enabled + CARGO points into the shim dir itself -> no warning", () => {
  const cargoShim = `${POSIX_SHIM_DIR}/cargo`;
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/bin`,
    cargoEnv: cargoShim,
    platform: "linux",
    pathSep: ":",
  });
  assert.deepEqual(warnings, []);
});

test("shims enabled + multiple offenders -> multiple warnings", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: "/home/runner/.cargo/bin:/usr/bin", // shim dir absent
    cargoEnv: "/home/runner/.cargo/bin/cargo",
    rustcEnv: "/home/runner/.rustup/toolchains/stable/bin/rustc",
    rustcWrapperEnv: "/opt/sccache/bin/sccache",
    platform: "linux",
    pathSep: ":",
  });
  // path-missing + CARGO + RUSTC + RUSTC_WRAPPER == 4 warnings
  assert.equal(warnings.length, 4);
});

test("windows: case-insensitive PATH comparison + .cmd shim recognition", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: WIN_SHIM_DIR,
    // Same dir, different case + trailing backslash — should still match.
    path: "C:\\RUNNER\\.SETUP-SOLDR\\SHIMS\\;C:\\Windows\\System32",
    platform: "win32",
    pathSep: ";",
  });
  assert.deepEqual(warnings, []);
});

test("windows: CARGO set to a non-shim absolute path -> warning suggests .cmd shim", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: WIN_SHIM_DIR,
    path: `${WIN_SHIM_DIR};C:\\Windows\\System32`,
    cargoEnv: "C:\\Users\\runner\\.cargo\\bin\\cargo.exe",
    platform: "win32",
    pathSep: ";",
  });
  assert.equal(warnings.length, 1);
  const msg = warnings[0]!;
  assert.match(msg, /CARGO env var is set to C:\\Users\\runner\\\.cargo\\bin\\cargo\.exe/);
  assert.match(msg, /shims\\cargo\.cmd/);
});

test("relative CARGO value (no abs path) -> no warning", () => {
  // A relative CARGO like "cargo" defers to PATH lookup, which the PATH
  // ordering check already covers. Don't double-flag.
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: POSIX_SHIM_DIR,
    path: `${POSIX_SHIM_DIR}:/usr/bin`,
    cargoEnv: "cargo",
    platform: "linux",
    pathSep: ":",
  });
  assert.deepEqual(warnings, []);
});

test("empty shimDir -> no warnings (defensive: nothing to compare against)", () => {
  const warnings = diagnoseShimBypass({
    shimsEnabled: true,
    shimDir: "",
    path: "/usr/bin",
    platform: "linux",
    pathSep: ":",
  });
  assert.deepEqual(warnings, []);
});
