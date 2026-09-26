import { spawn } from "node:child_process";

/**
 * Run two processes piped together: producer.stdout -> consumer.stdin.
 * Success is decided by the two exit codes alone.
 *
 * A consumer may exit before reading all of its input: bsdtar (macOS
 * `tar`) stops at the end-of-archive marker and leaves the pax record
 * padding unread. The next write to its stdin then fails with EPIPE. That
 * is not a failure by itself — the consumer's exit code says whether it
 * got what it needed — so the rest of the producer's output is drained and
 * discarded. Without a listener the EPIPE is an unhandled 'error' event
 * that kills the action (#531), and without the drain the producer would
 * block forever on a full pipe.
 */
export function runPipe(
  producer: [string, string[]],
  consumer: [string, string[]],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const prod = spawn(producer[0], producer[1], { stdio: ["ignore", "pipe", "inherit"] });
    const cons = spawn(consumer[0], consumer[1], { stdio: ["pipe", "inherit", "inherit"] });
    prod.once("error", fail);
    cons.once("error", fail);
    const output = prod.stdout!;
    const input = cons.stdin!;
    input.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") {
        fail(err);
        return;
      }
      output.unpipe(input);
      output.resume();
    });
    output.on("error", fail);
    output.pipe(input);

    let producerExit: string | null = null;
    let consumerExit: string | null = null;
    const done = (): void => {
      if (producerExit === null || consumerExit === null) return;
      if (producerExit !== "0") fail(new Error(`${producer[0]} exited with ${producerExit}`));
      else if (consumerExit !== "0") fail(new Error(`${consumer[0]} exited with ${consumerExit}`));
      else if (!settled) {
        settled = true;
        resolve();
      }
    };
    // A signal death has no exit code; it is never a success.
    const describe = (code: number | null, signal: NodeJS.Signals | null): string =>
      code === null ? `signal ${signal ?? "unknown"}` : code === 0 ? "0" : `code ${code}`;
    prod.once("close", (code, signal) => {
      producerExit = describe(code, signal);
      done();
    });
    cons.once("close", (code, signal) => {
      consumerExit = describe(code, signal);
      done();
    });
  });
}
