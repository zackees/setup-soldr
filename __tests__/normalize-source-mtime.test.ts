import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCandidateFiles, _internal } from "../src/lib/normalize-source-mtime.js";

test("selectCandidateFiles includes .rs files", () => {
  const tracked = ["src/main.rs", "crates/foo/src/lib.rs", "README.md"];
  const out = selectCandidateFiles(tracked);
  assert.deepEqual(out.sort(), ["crates/foo/src/lib.rs", "src/main.rs"].sort());
});

test("selectCandidateFiles includes Cargo.toml/lock and build.rs", () => {
  const tracked = ["Cargo.toml", "crates/bar/Cargo.toml", "Cargo.lock", "build.rs", "crates/foo/build.rs"];
  const out = selectCandidateFiles(tracked);
  assert.deepEqual(out.sort(), tracked.sort());
});

test("selectCandidateFiles excludes target/, .git/, node_modules/", () => {
  const tracked = [
    "target/debug/foo.rs",
    "src/main.rs",
    ".git/HEAD",
    "node_modules/x/y.rs",
    "crates/foo/target/baz.rs",
  ];
  const out = selectCandidateFiles(tracked);
  assert.deepEqual(out, ["src/main.rs"]);
});

test("selectCandidateFiles excludes unrelated files", () => {
  const tracked = ["package.json", "go.mod", "README.md"];
  const out = selectCandidateFiles(tracked);
  assert.deepEqual(out, []);
});

test("selectCandidateFiles handles windows-style backslashes", () => {
  const tracked = ["src\\main.rs", "Cargo.toml"];
  const out = selectCandidateFiles(tracked);
  assert.deepEqual(out.sort(), ["src/main.rs", "Cargo.toml"].sort());
});

test("rust-toolchain files are picked up", () => {
  const tracked = ["rust-toolchain", "rust-toolchain.toml"];
  const out = selectCandidateFiles(tracked);
  assert.deepEqual(out.sort(), tracked.sort());
});

test("fnmatchToRegex translates ** glob", () => {
  const re = _internal.fnmatchToRegex("**/*.rs");
  assert.ok(re.test("src/foo.rs"));
  assert.ok(re.test("a/b/c/foo.rs"));
});

test("isExcluded handles nested target dirs", () => {
  assert.equal(_internal.isExcluded("crates/foo/target/bar.rs"), true);
  assert.equal(_internal.isExcluded("crates/target.rs"), false);
});
