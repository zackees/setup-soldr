import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync("action.yml", "utf8");
const rustCi = readFileSync(".github/workflows/rust-ci.yml", "utf8");

test("action and reusable Rust CI default Dylint tools to 6.0.1", () => {
  for (const name of ["cargo-dylint-version", "dylint-link-version"]) {
    assert.match(
      action,
      new RegExp(`${name}:[\\s\\S]*?default: "6\\.0\\.1"`),
      `${name} action default must remain 6.0.1`,
    );
    assert.match(
      rustCi,
      new RegExp(`${name}:[\\s\\S]*?default: "6\\.0\\.1"`),
      `${name} reusable-workflow default must remain 6.0.1`,
    );
  }
});

test("reusable Rust CI installs the exact requested Dylint tool versions", () => {
  assert.match(rustCi, /"cargo-dylint@\$\{CARGO_DYLINT_VERSION\}"/);
  assert.match(rustCi, /"dylint-link@\$\{DYLINT_LINK_VERSION\}"/);
  assert.match(
    rustCi,
    /cargo-dylint-version: \$\{\{ inputs\.cargo-dylint-version \}\}/,
  );
  assert.match(
    rustCi,
    /dylint-link-version: \$\{\{ inputs\.dylint-link-version \}\}/,
  );
});
