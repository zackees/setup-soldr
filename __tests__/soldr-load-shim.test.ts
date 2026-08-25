import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

import "./cargo-registry-archive.test.ts";

import {
  detectSoldrManifest,
  semverGte,
  tryLoadViaSoldr,
  parseSoldrLoadReport,
  trySaveViaSoldr,
  cargoRegistryViaSoldrEnvOn,
  CARGO_REGISTRY_VIA_SOLDR_ENV,
  MIN_SOLDR_VERSION_FOR_LOAD,
  MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP,
} from "../src/lib/soldr-load-shim.js";

import {
  cargoRegistryArchiveFormat,
  planCargoRegistryArchive,
  cargoRegistryPayloadPaths,
} from "../src/lib/cargo-registry-archive.js";

test("#475 parses Soldr's authoritative restored-file report", () => {
  assert.deepEqual(
    parseSoldrLoadReport('diagnostic noise\n{"cache_files_restored":7,"cache_bytes_restored":1234}\n'),
    { restoredFiles: 7, restoredBytes: 1234 },
  );
  assert.deepEqual(parseSoldrLoadReport('{"command":"load"}'), {
    restoredFiles: null,
    restoredBytes: null,
  });
});

test("v2 cargo-registry plan owns registry and optional extras without CARGO_HOME", () => {
  const cargoHome = path.join("runner", "cargo-home");
  const plan = planCargoRegistryArchive({
    format: "soldr-v2",
    cargoHome,
    runnerTemp: path.join("runner", "temp"),
  });
  assert.equal(plan.format, "soldr-v2");
  assert.equal(plan.registryArchivePath, path.join("runner", "temp", "setup-soldr-cargo-registry", "v2", "registry.soldr.tar.zst"));
  assert.equal(plan.extrasArchivePath, path.join("runner", "temp", "setup-soldr-cargo-registry", "v2", "extras.tar.zst"));
  assert.deepEqual(plan.restorePaths, [plan.registryArchivePath, plan.extrasArchivePath]);
  assert.ok(!plan.restorePaths.includes(cargoHome));
});

test("legacy cargo-registry plan preserves the v1 combined archive", () => {
  const cargoHome = path.join("runner", "cargo-home");
  const plan = planCargoRegistryArchive({
    format: "legacy-v1",
    cargoHome,
    runnerTemp: path.join("runner", "temp"),
  });
  assert.equal(plan.format, "legacy-v1");
  assert.equal(plan.registryArchivePath, `${path.join(cargoHome, "registry")}.tar.zst`);
  assert.equal(plan.extrasArchivePath, "");
  assert.deepEqual(plan.restorePaths, [plan.registryArchivePath]);
});

test("cargo-registry format keeps encryption and explicit rollback on legacy v1", () => {
  assert.equal(cargoRegistryArchiveFormat({ encrypted: true, viaSoldr: true, sourceRef: false }), "legacy-v1");
  assert.equal(cargoRegistryArchiveFormat({ encrypted: false, viaSoldr: false, sourceRef: false }), "legacy-v1");
  assert.equal(cargoRegistryArchiveFormat({ encrypted: false, viaSoldr: true, sourceRef: false }), "soldr-v2");
  assert.equal(cargoRegistryArchiveFormat({ encrypted: false, viaSoldr: true, sourceRef: true }), "legacy-v1");
});

test("cargo-registry payload allowlist excludes credentials, bin, and unrelated state", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cargo-registry-plan-"));
  try {
    await fs.mkdir(path.join(tmp, "registry"));
    await fs.mkdir(path.join(tmp, "git"));
    await fs.mkdir(path.join(tmp, "bin"));
    await fs.writeFile(path.join(tmp, ".global-cache"), "gc");
    await fs.writeFile(path.join(tmp, "credentials.toml"), "secret");
    const payload = await cargoRegistryPayloadPaths(tmp);
    assert.deepEqual(payload, {
      registry: path.join(tmp, "registry"),
      extras: [path.join(tmp, ".global-cache"), path.join(tmp, "git")],
    });
    assert.ok(!JSON.stringify(payload).includes("credentials.toml"));
    assert.ok(!JSON.stringify(payload).includes(`${path.sep}bin`));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("missing optional cargo-registry extras are valid", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cargo-registry-plan-"));
  try {
    await fs.mkdir(path.join(tmp, "registry"));
    assert.deepEqual(await cargoRegistryPayloadPaths(tmp), {
      registry: path.join(tmp, "registry"),
      extras: [],
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("semverGte: handles MAJOR.MINOR.PATCH ordering", () => {
  assert.equal(semverGte("0.7.46", MIN_SOLDR_VERSION_FOR_LOAD), true);
  assert.equal(semverGte("0.7.45", MIN_SOLDR_VERSION_FOR_LOAD), false);
  assert.equal(semverGte("0.8.0", MIN_SOLDR_VERSION_FOR_LOAD), true);
  assert.equal(semverGte("1.0.0", MIN_SOLDR_VERSION_FOR_LOAD), true);
  assert.equal(semverGte("v0.7.46", MIN_SOLDR_VERSION_FOR_LOAD), true);
  assert.equal(semverGte("", MIN_SOLDR_VERSION_FOR_LOAD), false);
  assert.equal(semverGte("garbage", MIN_SOLDR_VERSION_FOR_LOAD), false);
});

test("detectSoldrManifest: returns true for tar with SOLDR_MANIFEST.pb as first entry", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "soldr-shim-"));
  try {
    // Build a tiny tar+zstd archive whose first entry is SOLDR_MANIFEST.pb.
    const stage = path.join(tmp, "stage");
    await fs.mkdir(stage);
    // Manifest first; second entry alphabetically/lexically must not come before.
    await fs.writeFile(path.join(stage, "SOLDR_MANIFEST.pb"), "dummy-manifest-bytes");
    await fs.mkdir(path.join(stage, "cache"));
    await fs.writeFile(path.join(stage, "cache", "entry.bin"), "hello");
    const archive = path.join(tmp, "out.tar.zst");
    // tar -cf - --use-compress-program "zstd -1" -C stage SOLDR_MANIFEST.pb cache > archive
    const res = spawnSync(
      "tar",
      [
        "--use-compress-program",
        "zstd -1",
        "-cf",
        archive,
        "-C",
        stage,
        "SOLDR_MANIFEST.pb",
        "cache",
      ],
      { stdio: "ignore" },
    );
    if (res.status !== 0) {
      // Skip cleanly when host doesn't have zstd CLI.
      console.log("skipping detectSoldrManifest: tar+zstd missing or failed");
      return;
    }
    assert.equal(await detectSoldrManifest(archive), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("detectSoldrManifest: returns false for plain tar (no manifest)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "soldr-shim-"));
  try {
    const stage = path.join(tmp, "stage");
    await fs.mkdir(stage);
    await fs.mkdir(path.join(stage, "registry"));
    await fs.writeFile(path.join(stage, "registry", "thing.txt"), "plain");
    const archive = path.join(tmp, "out.tar.zst");
    const res = spawnSync(
      "tar",
      ["--use-compress-program", "zstd -1", "-cf", archive, "-C", stage, "registry"],
      { stdio: "ignore" },
    );
    if (res.status !== 0) {
      console.log("skipping detectSoldrManifest negative case: tar+zstd missing");
      return;
    }
    assert.equal(await detectSoldrManifest(archive), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("detectSoldrManifest: returns false for nonexistent file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "soldr-shim-"));
  try {
    const fake = path.join(tmp, "does-not-exist.tar.zst");
    assert.equal(await detectSoldrManifest(fake), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("tryLoadViaSoldr: returns used=false when soldrPath is empty", async () => {
  const r = await tryLoadViaSoldr({
    archivePath: "/no/such/file",
    targetDir: "/no/such/dir",
    soldrPath: "",
    soldrVersion: "0.7.46",
  });
  assert.equal(r.used, false);
});

test("tryLoadViaSoldr: returns used=false when soldr version is too old", async () => {
  const r = await tryLoadViaSoldr({
    archivePath: "/no/such/file",
    targetDir: "/no/such/dir",
    soldrPath: "/fake/path/soldr",
    soldrVersion: "0.7.45",
  });
  assert.equal(r.used, false);
});

test("tryLoadViaSoldr: returns used=false when archive missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "soldr-shim-"));
  try {
    const r = await tryLoadViaSoldr({
      archivePath: path.join(tmp, "missing.tar.zst"),
      targetDir: tmp,
      soldrPath: "/fake/path/soldr",
      soldrVersion: "0.7.46",
    });
    assert.equal(r.used, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("cargoRegistryViaSoldrEnvOn: env-var truthy/falsy behavior", () => {
  const orig = process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
  try {
    delete process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
    assert.equal(cargoRegistryViaSoldrEnvOn(), false);
    process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = "";
    assert.equal(cargoRegistryViaSoldrEnvOn(), false);
    process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = "0";
    assert.equal(cargoRegistryViaSoldrEnvOn(), false);
    process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = "false";
    assert.equal(cargoRegistryViaSoldrEnvOn(), false);
    process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = "1";
    assert.equal(cargoRegistryViaSoldrEnvOn(), true);
    process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = "true";
    assert.equal(cargoRegistryViaSoldrEnvOn(), true);
    process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = "yes";
    assert.equal(cargoRegistryViaSoldrEnvOn(), true);
  } finally {
    if (orig === undefined) delete process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
    else process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = orig;
  }
});

test("trySaveViaSoldr: gated off when env var unset (default)", async () => {
  const orig = process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
  delete process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
  try {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "soldr-save-shim-"));
    try {
      await fs.mkdir(path.join(tmp, "cache"));
      const r = await trySaveViaSoldr({
        cacheDir: path.join(tmp, "cache"),
        archivePath: path.join(tmp, "out.tar.zst"),
        soldrPath: "/fake/path/soldr",
        soldrVersion: MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP,
      });
      assert.equal(r.used, false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  } finally {
    if (orig === undefined) delete process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
    else process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = orig;
  }
});

test("trySaveViaSoldr: gated off when soldr version is too old (even with env on)", async () => {
  const orig = process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
  process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = "1";
  try {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "soldr-save-shim-"));
    try {
      await fs.mkdir(path.join(tmp, "cache"));
      const r = await trySaveViaSoldr({
        cacheDir: path.join(tmp, "cache"),
        archivePath: path.join(tmp, "out.tar.zst"),
        soldrPath: "/fake/path/soldr",
        soldrVersion: "0.7.46", // one below the 0.7.47 minimum
      });
      assert.equal(r.used, false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  } finally {
    if (orig === undefined) delete process.env[CARGO_REGISTRY_VIA_SOLDR_ENV];
    else process.env[CARGO_REGISTRY_VIA_SOLDR_ENV] = orig;
  }
});

test("tryLoadViaSoldr: returns used=false for legacy (non-soldr) archive", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "soldr-shim-"));
  try {
    const stage = path.join(tmp, "stage");
    await fs.mkdir(stage);
    await fs.mkdir(path.join(stage, "registry"));
    await fs.writeFile(path.join(stage, "registry", "x.txt"), "legacy");
    const archive = path.join(tmp, "legacy.tar.zst");
    const res = spawnSync(
      "tar",
      ["--use-compress-program", "zstd -1", "-cf", archive, "-C", stage, "registry"],
      { stdio: "ignore" },
    );
    if (res.status !== 0) {
      console.log("skipping legacy-archive case: tar+zstd missing");
      return;
    }
    const r = await tryLoadViaSoldr({
      archivePath: archive,
      targetDir: tmp,
      soldrPath: "/fake/path/soldr",
      soldrVersion: "0.7.46",
    });
    assert.equal(r.used, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
