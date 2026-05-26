import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBooleanInput, parseOptionalSeconds } from "../src/lib/cleanup-inputs.js";

test("cleanup parses boolean inputs", () => {
  assert.equal(parseBooleanInput("fail-on-error", "", true), true);
  assert.equal(parseBooleanInput("fail-on-error", "false", true), false);
  assert.equal(parseBooleanInput("fail-on-error", "ON", false), true);
  assert.throws(
    () => parseBooleanInput("fail-on-error", "maybe", true),
    /invalid 'fail-on-error' input/,
  );
});

test("cleanup parses optional timeout seconds", () => {
  assert.equal(parseOptionalSeconds("shutdown-timeout-seconds", ""), undefined);
  assert.equal(parseOptionalSeconds("shutdown-timeout-seconds", "0"), 0);
  assert.equal(parseOptionalSeconds("shutdown-timeout-seconds", "30"), 30);
  assert.throws(
    () => parseOptionalSeconds("shutdown-timeout-seconds", "30s"),
    /invalid 'shutdown-timeout-seconds' input/,
  );
});
