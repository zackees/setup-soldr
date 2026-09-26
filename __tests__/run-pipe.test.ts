import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPipe } from "../src/lib/run-pipe.js";

const node = process.execPath;
const SIXTEEN_MIB = 16 * 1024 * 1024;

/** Writes `bytes` to stdout, then exits with `exitCode`. */
function producer(bytes: number, exitCode = 0): [string, string[]] {
  return [
    node,
    ["-e", `process.stdout.write(Buffer.alloc(${bytes}, 7), () => process.exit(${exitCode}));`],
  ];
}

/**
 * Reads one chunk and exits with `exitCode` without draining stdin — the
 * shape of bsdtar stopping at the end-of-archive marker (#531).
 */
function earlyExitConsumer(exitCode: number): [string, string[]] {
  return [node, ["-e", `process.stdin.once("data", () => process.exit(${exitCode}));`]];
}

test("#531: a consumer that exits 0 before draining stdin does not crash or hang", async () => {
  await runPipe(producer(SIXTEEN_MIB), earlyExitConsumer(0));
});

test("#531: a consumer that exits non-zero before draining stdin rejects with its code", async () => {
  await assert.rejects(runPipe(producer(SIXTEEN_MIB), earlyExitConsumer(3)), /exited with code 3/);
});

test("runPipe delivers every producer byte to a draining consumer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-pipe-"));
  const out = path.join(dir, "out.bin");
  try {
    await runPipe(producer(SIXTEEN_MIB), [
      node,
      ["-e", `process.stdin.pipe(require("node:fs").createWriteStream(${JSON.stringify(out)}));`],
    ]);
    assert.equal(fs.statSync(out).size, SIXTEEN_MIB);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPipe rejects when the producer exits non-zero", async () => {
  await assert.rejects(
    runPipe(producer(1024, 2), [node, ["-e", "process.stdin.resume();"]]),
    /exited with code 2/,
  );
});

test("runPipe rejects when a process cannot be spawned", async () => {
  await assert.rejects(
    runPipe(producer(1024), [path.join(os.tmpdir(), "setup-soldr-no-such-binary"), []]),
    /ENOENT/,
  );
});
