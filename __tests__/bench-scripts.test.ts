import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("collate-bench appends amortized payback fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-collate-"));
  await fs.mkdir(path.join(dir, "cell"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "cell", "bench.csv"),
    [
      "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model",
      "Linux,target,cold,15,12,,8,62,7.75,demo-small,1,local-tar-zstd,zstd-19-long27",
      "Linux,target,warm,1,,0.5,8,62,7.75,demo-small,1,local-tar-zstd,zstd-19-long27",
      "",
    ].join("\n"),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, ["scripts/collate-bench.mjs", dir]);
  const lines = stdout.trim().split(/\r?\n/);
  const header = lines[0]!.split(",");
  const warm = lines.find((line) => line.includes(",target,warm,"))!.split(",");

  assert.ok(header.includes("break_even_warm_hits"));
  assert.ok(header.includes("cold_plus_save_s"));
  assert.equal(warm[header.indexOf("speedup_s")], "14");
  assert.equal(warm[header.indexOf("net_benefit_s")], "13.5");
  assert.equal(warm[header.indexOf("break_even_warm_hits")], "0.89");
  assert.equal(warm[header.indexOf("cold_plus_save_s")], "27");
});

test("render-bench-summary reports methodology, aggregates, and amortized flags", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-render-"));
  const csv = path.join(dir, "bench-matrix.csv");
  await fs.writeFile(
    csv,
    [
      "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model,speedup_s,net_benefit_s,mb_per_second_saved,break_even_warm_hits,cold_plus_save_s",
      "Linux,all-on,cold,15,200,,173,806,4.6,demo-small,1,local-tar-zstd,zstd-19-long27,,,,,215",
      "Linux,all-on,warm,1,,1,173,806,4.6,demo-small,1,local-tar-zstd,zstd-19-long27,14,13,12.36,15.38,215",
      "",
    ].join("\n"),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, ["scripts/render-bench-summary.mjs", csv]);
  assert.match(stdout, /### Methodology/);
  assert.match(stdout, /### Rep aggregates/);
  assert.match(stdout, /break_even_warm_hits=15\.38/);
  assert.match(stdout, /inflated_mb=806/);
});

test("bench-cache-cell writes a labeled partial-safe CSV in dry-run mode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cell-"));
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  await fs.mkdir(path.join(home, ".cargo"), { recursive: true });
  await fs.mkdir(path.join(home, ".rustup"), { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  const out = path.join(dir, "bench.csv");

  await execFileAsync(process.execPath, [
    "scripts/bench-cache-cell.mjs",
    "--layer=all-on",
    "--workload=demo-small",
    "--rep=1",
    "--out=" + out,
  ], {
    env: {
      ...process.env,
      BENCH_SKIP_BUILD: "1",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: runnerTemp,
      HOME: home,
      USERPROFILE: home,
      CARGO_HOME: path.join(home, ".cargo"),
      RUSTUP_HOME: path.join(home, ".rustup"),
      ZCCACHE_CACHE_DIR: path.join(home, ".cache", "zccache"),
      SETUP_SOLDR_CACHE_PATH: path.join(runnerTemp, "setup-soldr-cache"),
      SOLDR_INSTALL_DIR: path.join(runnerTemp, "setup-soldr-tools"),
    },
  });

  const csv = await fs.readFile(out, "utf8");
  const lines = csv.trim().split(/\r?\n/);
  assert.match(lines[0]!, /cache_backend,compression_model$/);
  assert.ok(lines.some((line) => line.includes(",all-on,cold,")));
  assert.ok(lines.some((line) => line.includes(",all-on,warm,")));
  assert.doesNotMatch(csv, /toolchains/);
});

test("bench-cache-cell treats cook-production as build-affecting", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cell-cook-prod-"));
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  await fs.mkdir(path.join(home, ".cargo"), { recursive: true });
  await fs.mkdir(path.join(home, ".rustup"), { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  const out = path.join(dir, "bench.csv");

  await execFileAsync(process.execPath, [
    "scripts/bench-cache-cell.mjs",
    "--layer=cook-production",
    "--workload=demo-small",
    "--rep=1",
    "--out=" + out,
  ], {
    env: {
      ...process.env,
      BENCH_SKIP_BUILD: "1",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: runnerTemp,
      HOME: home,
      USERPROFILE: home,
      CARGO_HOME: path.join(home, ".cargo"),
      RUSTUP_HOME: path.join(home, ".rustup"),
      ZCCACHE_CACHE_DIR: path.join(home, ".cache", "zccache"),
      SETUP_SOLDR_CACHE_PATH: path.join(runnerTemp, "setup-soldr-cache"),
      SOLDR_INSTALL_DIR: path.join(runnerTemp, "setup-soldr-tools"),
    },
  });

  const csv = await fs.readFile(out, "utf8");
  assert.ok(csv.split(/\r?\n/).some((line) => line.includes(",cook-production,warm,")));
});
