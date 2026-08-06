import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const reps = Number.parseInt(arg("reps", "3"), 10);
const requestedFileCount = Number.parseInt(arg("file-count", "50000"), 10);
const outputDir = path.resolve(arg("output-dir", "benchmark-output"));
const soldr = process.env.SOLDR_BIN?.trim() || "soldr";
const runnerOs = process.env.RUNNER_OS || os.platform();
const runnerImage = process.env.ImageOS || process.env.BENCH_RUNNER || "unknown";
const assertThresholds = /^(1|true|yes|on)$/i.test(process.env.BENCH_ASSERT_THRESHOLDS || "false");

if (!Number.isInteger(reps) || reps < 3) throw new Error("--reps must be an integer >= 3");
if (!Number.isInteger(requestedFileCount) || requestedFileCount < 1) {
  throw new Error("--file-count must be a positive integer");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function runPipe(producer, producerArgs, consumer, consumerArgs) {
  return new Promise((resolve, reject) => {
    const left = spawn(producer, producerArgs, { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const right = spawn(consumer, consumerArgs, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
    left.once("error", reject);
    right.once("error", reject);
    left.stdout.pipe(right.stdin);
    let leftCode = null;
    let rightCode = null;
    const finish = () => {
      if (leftCode === null || rightCode === null) return;
      if (leftCode !== 0) reject(new Error(`${producer} exited with code ${leftCode}`));
      else if (rightCode !== 0) reject(new Error(`${consumer} exited with code ${rightCode}`));
      else resolve();
    };
    left.once("close", (code) => { leftCode = code ?? 0; finish(); });
    right.once("close", (code) => { rightCode = code ?? 0; finish(); });
  });
}

async function createFixture(cargoHome) {
  const registry = path.join(cargoHome, "registry");
  await fs.mkdir(registry, { recursive: true });
  const batchSize = 250;
  for (let start = 0; start < requestedFileCount; start += batchSize) {
    const writes = [];
    for (let i = start; i < Math.min(start + batchSize, requestedFileCount); i += 1) {
      const bucket = (i % 256).toString(16).padStart(2, "0");
      const target = path.join(registry, bucket, `crate-${i.toString().padStart(6, "0")}.cache`);
      const content = `setup-soldr cargo registry benchmark\nindex=${i}\nchecksum=${createHash("sha256").update(String(i)).digest("hex")}\n`;
      writes.push(fs.mkdir(path.dirname(target), { recursive: true }).then(() => fs.writeFile(target, content)));
    }
    await Promise.all(writes);
  }
  await fs.mkdir(path.join(cargoHome, ".global-cache"), { recursive: true });
  await fs.writeFile(path.join(cargoHome, ".global-cache", "state.json"), '{"fixture":true}\n');
  await fs.mkdir(path.join(cargoHome, "git", "db", "fixture.git"), { recursive: true });
  await fs.writeFile(path.join(cargoHome, "git", "db", "fixture.git", "HEAD"), "ref: refs/heads/main\n");
}

async function listFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, full));
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return files;
}

async function contentIdentity(root) {
  const files = (await listFiles(root)).sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    digest.update(relative);
    digest.update("\0");
    await new Promise((resolve, reject) => {
      const stream = createReadStream(path.join(root, ...relative.split("/")));
      stream.on("data", (chunk) => digest.update(chunk));
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    digest.update("\0");
  }
  return { fileCount: files.length, contentHash: digest.digest("hex") };
}

async function archiveLegacy(cargoHome, archive) {
  await runPipe(
    "tar", ["-cf", "-", "-C", cargoHome, "registry", ".global-cache", "git"],
    "zstd", ["-T0", "-3", "-f", "-o", archive],
  );
}

async function archiveSoldr(cargoHome, registryArchive, extrasArchive) {
  await run(soldr, ["save", "--cache-dir", path.join(cargoHome, "registry"), "--out", registryArchive]);
  await runPipe(
    "tar", ["-cf", "-", "-C", cargoHome, ".global-cache", "git"],
    "zstd", ["-T0", "-3", "-f", "-o", extrasArchive],
  );
}

async function restoreLegacy(archive, cargoHome) {
  await fs.mkdir(cargoHome, { recursive: true });
  await runPipe("zstd", ["-d", "-T0", "-c", archive], "tar", ["-xf", "-", "-C", cargoHome]);
}

async function restoreSoldr(registryArchive, extrasArchive, cargoHome) {
  const args = ["load", "--archive", registryArchive, "--cache-dir", path.join(cargoHome, "registry")];
  if (process.platform === "win32") args.push("--auto-defender-exclude");
  await run(soldr, args);
  await fs.mkdir(cargoHome, { recursive: true });
  await runPipe("zstd", ["-d", "-T0", "-c", extrasArchive], "tar", ["-xf", "-", "-C", cargoHome]);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "setup-soldr-registry-bench-"));
const fixture = path.join(root, "fixture", "cargo-home");
const restoreRoot = path.join(root, "restore", "cargo-home");
const legacyArchive = path.join(root, "legacy.tar.zst");
const registryArchive = path.join(root, "registry.soldr.tar.zst");
const extrasArchive = path.join(root, "extras.tar.zst");
const rows = [];

try {
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`Creating deterministic ${requestedFileCount}-file registry fixture...`);
  await createFixture(fixture);
  const expected = await contentIdentity(fixture);
  await archiveLegacy(fixture, legacyArchive);
  await archiveSoldr(fixture, registryArchive, extrasArchive);
  const archiveBytes = {
    legacy: (await fs.stat(legacyArchive)).size,
    soldr: (await fs.stat(registryArchive)).size + (await fs.stat(extrasArchive)).size,
  };

  for (let rep = 1; rep <= reps; rep += 1) {
    const order = rep % 2 === 1 ? "legacy,soldr" : "soldr,legacy";
    for (const codecPath of order.split(",")) {
      await fs.rm(path.dirname(restoreRoot), { recursive: true, force: true });
      const started = process.hrtime.bigint();
      let restoreMs = 0;
      let success = false;
      let actual = { fileCount: 0, contentHash: "" };
      let error = "";
      try {
        if (codecPath === "legacy") await restoreLegacy(legacyArchive, restoreRoot);
        else await restoreSoldr(registryArchive, extrasArchive, restoreRoot);
        restoreMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        actual = await contentIdentity(restoreRoot);
        success = actual.fileCount === expected.fileCount && actual.contentHash === expected.contentHash;
        if (!success) error = "content hash or file count mismatch";
      } catch (caught) {
        restoreMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        error = caught instanceof Error ? caught.message : String(caught);
      }
      rows.push({
        runner_os: runnerOs,
        runner_image: runnerImage,
        rep,
        codec_path: codecPath,
        archive_bytes: archiveBytes[codecPath],
        file_count: actual.fileCount,
        restore_ms: restoreMs.toFixed(3),
        content_hash: actual.contentHash,
        success,
        error,
      });
      console.log(`rep=${rep} codec=${codecPath} restore_ms=${restoreMs.toFixed(3)} success=${success}`);
    }
  }

  const headers = ["runner_os", "runner_image", "rep", "codec_path", "archive_bytes", "file_count", "restore_ms", "content_hash", "success", "error"];
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n";
  const csvPath = path.join(outputDir, "cargo-registry-archive-benchmark.csv");
  await fs.writeFile(csvPath, csv);

  const valid = rows.every((row) => row.success);
  const legacyMedian = median(rows.filter((row) => row.codec_path === "legacy").map((row) => Number(row.restore_ms)));
  const soldrMedian = median(rows.filter((row) => row.codec_path === "soldr").map((row) => Number(row.restore_ms)));
  const speedup = legacyMedian / soldrMedian;
  const gatePassed = valid && soldrMedian < 25000 && legacyMedian >= 3 * soldrMedian;
  const summary = [
    "# Cargo-registry archive restore benchmark",
    "",
    `- Runner: \`${runnerOs}\` / \`${runnerImage}\``,
    `- Fixture: ${expected.fileCount} total files (${requestedFileCount} registry files)`,
    `- Repetitions: ${reps}; order alternates between \`legacy,soldr\` and \`soldr,legacy\``,
    `- Legacy median restore: ${legacyMedian.toFixed(3)} ms`,
    `- Soldr median restore: ${soldrMedian.toFixed(3)} ms`,
    `- Speedup: ${speedup.toFixed(2)}x`,
    `- Content validation: ${valid ? "PASS" : "FAIL"} (file count and SHA-256 content hash after every restore)`,
    `- Default-on gate: ${gatePassed ? "PASS" : "FAIL"} (Soldr < 25000 ms and legacy >= 3 * Soldr)`,
    "",
    "| rep | codec | restore ms | archive bytes | files | valid |",
    "| ---: | :--- | ---: | ---: | ---: | :---: |",
    ...rows.map((row) => `| ${row.rep} | ${row.codec_path} | ${row.restore_ms} | ${row.archive_bytes} | ${row.file_count} | ${row.success ? "yes" : "no"} |`),
    "",
  ].join("\n");
  const summaryPath = path.join(outputDir, "cargo-registry-archive-benchmark.md");
  await fs.writeFile(summaryPath, summary);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!valid) throw new Error("benchmark content hash validation failed");
  if (assertThresholds && !gatePassed) throw new Error("Soldr default-on performance thresholds were not met");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
