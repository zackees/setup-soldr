import { test } from "node:test";
import assert from "node:assert/strict";
import {
  colorForceEnvironment,
  createLogger,
  formatLogLine,
  getTimestampFormat,
  isTimestampsEnabled,
} from "../src/lib/log-utils.js";

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

// --- #387 Feature 2: timestamp-format mmss vs seconds ----------------------

test("getTimestampFormat defaults to mmss when env unset", () => {
  assert.equal(getTimestampFormat({}), "mmss");
});

test("getTimestampFormat reads SETUP_SOLDR_TIMESTAMP_FORMAT=seconds", () => {
  assert.equal(getTimestampFormat({ SETUP_SOLDR_TIMESTAMP_FORMAT: "seconds" }), "seconds");
});

test("getTimestampFormat is case-insensitive and trims whitespace", () => {
  assert.equal(getTimestampFormat({ SETUP_SOLDR_TIMESTAMP_FORMAT: "  SECONDS  " }), "seconds");
  assert.equal(getTimestampFormat({ SETUP_SOLDR_TIMESTAMP_FORMAT: "MMSS" }), "mmss");
});

test("getTimestampFormat falls back to mmss for unknown values", () => {
  assert.equal(getTimestampFormat({ SETUP_SOLDR_TIMESTAMP_FORMAT: "decimal" }), "mmss");
  assert.equal(getTimestampFormat({ SETUP_SOLDR_TIMESTAMP_FORMAT: "" }), "mmss");
});

test("formatLogLine with format=seconds emits two-decimal seconds prefix", () => {
  const now = Date.now() / 1000;
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_TIMESTAMP_FORMAT: "seconds",
    SETUP_SOLDR_LOG_START_EPOCH: String(now - 8.04),
  };
  const line = formatLogLine(env, "downloading soldr 0.7.56");
  // Allow a small jitter window between Date.now() readings.
  assert.match(line, /^\d+\.\d{2} downloading soldr 0\.7\.56$/);
  const elapsed = Number(line.split(" ", 1)[0]);
  assert.ok(elapsed >= 8.0 && elapsed <= 9.0, `expected ~8.04, got ${elapsed}`);
});

test("formatLogLine with format=seconds at start epoch emits 0.NN", () => {
  const now = Date.now() / 1000;
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_TIMESTAMP_FORMAT: "seconds",
    SETUP_SOLDR_LOG_START_EPOCH: String(now),
  };
  const line = formatLogLine(env, "boot");
  assert.match(line, /^0\.\d{2} boot$/);
});

test("formatLogLine with format=seconds clamps negative elapsed to 0.00", () => {
  const future = Math.floor(Date.now() / 1000) + 10_000;
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_TIMESTAMP_FORMAT: "seconds",
    SETUP_SOLDR_LOG_START_EPOCH: String(future),
  };
  assert.equal(formatLogLine(env, "msg"), "0.00 msg");
});

test("formatLogLine with format=seconds AND timestamps=false suppresses prefix", () => {
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "false",
    SETUP_SOLDR_TIMESTAMP_FORMAT: "seconds",
  };
  assert.equal(formatLogLine(env, "raw"), "raw");
});

test("formatLogLine default format is mmss (back-compat)", () => {
  const now = Math.floor(Date.now() / 1000);
  const env = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_LOG_START_EPOCH: String(now - 65),
  };
  const line = formatLogLine(env, "hello");
  // mmss shape is preserved when SETUP_SOLDR_TIMESTAMP_FORMAT is unset.
  assert.match(line, /^0[01]:\d{2} hello$/);
});

test("formatLogLine preserves ANSI color codes in the line body", () => {
  // SGR: ESC[31m (red) ... ESC[0m (reset). The prefix must not touch the body.
  const colored = "\x1b[31mERROR\x1b[0m boom";
  const now = Math.floor(Date.now() / 1000);
  const envMmss = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_LOG_START_EPOCH: String(now),
  };
  const mmss = formatLogLine(envMmss, colored);
  assert.ok(mmss.endsWith(colored), `mmss should pass SGR through: ${JSON.stringify(mmss)}`);

  const envSeconds = {
    SETUP_SOLDR_TIMESTAMPS: "true",
    SETUP_SOLDR_TIMESTAMP_FORMAT: "seconds",
    SETUP_SOLDR_LOG_START_EPOCH: String(now),
  };
  const sec = formatLogLine(envSeconds, colored);
  assert.ok(sec.endsWith(colored), `seconds should pass SGR through: ${JSON.stringify(sec)}`);
});
