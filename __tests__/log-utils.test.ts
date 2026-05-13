import { test } from "node:test";
import assert from "node:assert/strict";
import { colorForceEnvironment, createLogger, formatLogLine, isTimestampsEnabled } from "../src/lib/log-utils.js";

test("timestampsEnabled returns true by default", () => {
  assert.equal(isTimestampsEnabled({}), true);
});

test("timestampsEnabled honors falsy aliases", () => {
  for (const v of ["0", "false", "FALSE", "No", "off", " false "]) {
    assert.equal(isTimestampsEnabled({ SETUP_SOLDR_TIMESTAMPS: v }), false, `for ${JSON.stringify(v)}`);
  }
});

test("timestampsEnabled treats truthy aliases as enabled", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE", "  true  "]) {
    assert.equal(isTimestampsEnabled({ SETUP_SOLDR_TIMESTAMPS: v }), true, `for ${JSON.stringify(v)}`);
  }
});

test("formatLogLine prefixes mm:ss when timestamps enabled", () => {
  const now = Math.floor(Date.now() / 1000);
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_LOG_START_EPOCH: String(now - 65),
  };
  const line = formatLogLine(env, "hello");
  assert.match(line, /^0[01]:\d{2} hello$/);
});

test("formatLogLine pads to mm:ss zero", () => {
  const now = Math.floor(Date.now() / 1000);
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_LOG_START_EPOCH: String(now),
  };
  const line = formatLogLine(env, "boot");
  assert.match(line, /^00:0\d boot$/);
});

test("formatLogLine returns raw line when timestamps disabled", () => {
  assert.equal(formatLogLine({ SETUP_SOLDR_TIMESTAMPS: "false" }, "raw"), "raw");
});

test("formatLogLine clamps negative elapsed to 00:00", () => {
  const future = Math.floor(Date.now() / 1000) + 10_000;
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_LOG_START_EPOCH: String(future),
  };
  const line = formatLogLine(env, "msg");
  assert.equal(line, "00:00 msg");
});

test("colorForceEnvironment returns empties when NO_COLOR set", () => {
  assert.deepEqual(colorForceEnvironment({ NO_COLOR: "1" }), {});
});

test("colorForceEnvironment returns empties when timestamps off", () => {
  assert.deepEqual(
    colorForceEnvironment({ SETUP_SOLDR_TIMESTAMPS: "false" }),
    {},
  );
});

test("colorForceEnvironment defaults to all three color overrides", () => {
  assert.deepEqual(colorForceEnvironment({}), {
    CARGO_TERM_COLOR: "always",
    CLICOLOR_FORCE: "1",
    FORCE_COLOR: "1",
  });
});

test("colorForceEnvironment omits already-set keys", () => {
  assert.deepEqual(
    colorForceEnvironment({ CARGO_TERM_COLOR: "never" }),
    { CLICOLOR_FORCE: "1", FORCE_COLOR: "1" },
  );
});

test("createLogger returns object with expected method shape", () => {
  const logger = createLogger({});
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.warning, "function");
  assert.equal(typeof logger.error, "function");
  assert.equal(typeof logger.debug, "function");
  assert.equal(typeof logger.log, "function");
});
