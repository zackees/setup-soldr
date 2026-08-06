import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  cargoRegistryArchiveFormat,
  cargoRegistryZstdAsset,
  cargoRegistryPayloadCensus,
  cargoRegistryPayloadPaths,
  extractCargoRegistryExtrasArchive,
  planCargoRegistryArchive,
  restoreCargoRegistryArchive,
  saveCargoRegistryArchive,
  writeCargoRegistryExtrasArchive,
  type CargoRegistryArchiveOperations,
} from "../src/lib/cargo-registry-archive.js";

test("cargo-registry v2 plans two deterministic runner-temp archives", () => {
  const cargoHome = path.join("runner", "cargo-home");
  const plan = planCargoRegistryArchive({
    format: "soldr-v2",
    cargoHome,
    runnerTemp: path.join("runner", "temp"),
  });
  assert.equal(
    plan.registryArchivePath,
    path.join(
      "runner",
      "temp",
      "setup-soldr-cargo-registry",
      "v2",
      "registry.soldr.tar.zst",
    ),
  );
  assert.equal(
    plan.extrasArchivePath,
    path.join("runner", "temp", "setup-soldr-cargo-registry", "v2", "extras.tar.zst"),
  );
  assert.deepEqual(plan.restorePaths, [plan.registryArchivePath, plan.extrasArchivePath]);
  assert.ok(!plan.restorePaths.some((entry) => entry === cargoHome));
});

test("format selection preserves encryption, rollback, source-ref, and old-runtime fallbacks", () => {
  assert.equal(
    cargoRegistryArchiveFormat({ encrypted: false, viaSoldr: true, sourceRef: false }),
    "soldr-v2",
  );
  assert.equal(
    cargoRegistryArchiveFormat({ encrypted: true, viaSoldr: true, sourceRef: false }),
    "legacy-v1",
  );
  assert.equal(
    cargoRegistryArchiveFormat({ encrypted: false, viaSoldr: false, sourceRef: false }),
    "legacy-v1",
  );
  assert.equal(
    cargoRegistryArchiveFormat({ encrypted: false, viaSoldr: true, sourceRef: true }),
    "legacy-v1",
  );
  assert.equal(
    cargoRegistryArchiveFormat({
      encrypted: false,
      viaSoldr: true,
      sourceRef: false,
      runtimeCompatible: false,
    }),
    "legacy-v1",
  );
});

test("Windows zstd bootstrap is pinned to the verified upstream win64 release", () => {
  assert.equal(
    cargoRegistryZstdAsset("x64"),
    "https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip",
  );
  assert.throws(() => cargoRegistryZstdAsset("ia32"), /does not support 32-bit/);
});

test("companion archive round trips without requiring a standalone zstd executable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cargo-registry-extras-"));
  const cargoHome = path.join(root, "cargo-home");
  const archive = path.join(root, "extras.tar.zst");
  try {
    await fs.mkdir(path.join(cargoHome, "git", "db"), { recursive: true });
    await fs.writeFile(path.join(cargoHome, ".global-cache"), "gc state");
    await fs.writeFile(path.join(cargoHome, "git", "db", "HEAD"), "git state");
    const extras = [path.join(cargoHome, ".global-cache"), path.join(cargoHome, "git")];
    await writeCargoRegistryExtrasArchive(cargoHome, extras, archive);
    await fs.rm(path.join(cargoHome, ".global-cache"), { force: true });
    await fs.rm(path.join(cargoHome, "git"), { recursive: true, force: true });
    await extractCargoRegistryExtrasArchive(cargoHome, archive);
    assert.equal(await fs.readFile(path.join(cargoHome, ".global-cache"), "utf8"), "gc state");
    assert.equal(await fs.readFile(path.join(cargoHome, "git", "db", "HEAD"), "utf8"), "git state");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v2 round trip owns registry and Cargo extras but never unrelated CARGO_HOME files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cargo-registry-archive-"));
  const cargoHome = path.join(root, "cargo-home");
  const snapshot = path.join(root, "snapshot");
  const runnerTemp = path.join(root, "runner-temp");
  const plan = planCargoRegistryArchive({ format: "soldr-v2", cargoHome, runnerTemp });
  const copiedExtras: string[] = [];
  const operations: CargoRegistryArchiveOperations = {
    async saveRegistry(cacheDir, archivePath) {
      await fs.cp(cacheDir, path.join(snapshot, "registry"), { recursive: true });
      await fs.writeFile(archivePath, "registry archive marker");
      return true;
    },
    async restoreRegistry(_archivePath, targetDir) {
      await fs.cp(path.join(snapshot, "registry"), targetDir, { recursive: true });
      return true;
    },
    async saveExtras(_cargoHome, extras, archivePath) {
      for (const extra of extras) {
        const basename = path.basename(extra);
        copiedExtras.push(basename);
        await fs.cp(extra, path.join(snapshot, basename), { recursive: true });
      }
      await fs.writeFile(archivePath, "extras archive marker");
    },
    async restoreExtras(targetCargoHome) {
      for (const basename of copiedExtras) {
        await fs.cp(path.join(snapshot, basename), path.join(targetCargoHome, basename), {
          recursive: true,
        });
      }
    },
  };

  try {
    await fs.mkdir(path.join(cargoHome, "registry"), { recursive: true });
    await fs.mkdir(path.join(cargoHome, "git", "db"), { recursive: true });
    await fs.writeFile(path.join(cargoHome, "registry", "crate.cache"), "registry payload");
    await fs.writeFile(path.join(cargoHome, ".global-cache"), "cargo gc state");
    await fs.writeFile(path.join(cargoHome, "git", "db", "HEAD"), "git payload");
    await fs.writeFile(path.join(cargoHome, "credentials.toml"), "secret must stay local");
    await fs.mkdir(path.dirname(plan.registryArchivePath), { recursive: true });

    const payload = await cargoRegistryPayloadPaths(cargoHome);
    assert.deepEqual(payload.extras.map((entry) => path.basename(entry)), [".global-cache", "git"]);
    const census = await cargoRegistryPayloadCensus(cargoHome, 10);
    assert.ok(census.inputs.includes("registry"));
    assert.ok(census.inputs.includes(".global-cache"));
    assert.ok(census.inputs.includes("git"));
    assert.ok(!JSON.stringify(census).includes("credentials.toml"));
    await saveCargoRegistryArchive({
      plan,
      cargoHome,
      soldrPath: "fake-soldr",
      soldrVersion: "0.7.47",
      operations,
    });
    assert.deepEqual(copiedExtras, [".global-cache", "git"]);
    assert.equal(await fs.readFile(path.join(cargoHome, "credentials.toml"), "utf8"), "secret must stay local");

    await fs.rm(path.join(cargoHome, "registry"), { recursive: true, force: true });
    await fs.rm(path.join(cargoHome, ".global-cache"), { force: true });
    await fs.rm(path.join(cargoHome, "git"), { recursive: true, force: true });
    await restoreCargoRegistryArchive({
      plan,
      cargoHome,
      soldrPath: "fake-soldr",
      soldrVersion: "0.7.47",
      cacheKey: "v2-test-key",
      operations,
    });

    assert.equal(await fs.readFile(path.join(cargoHome, "registry", "crate.cache"), "utf8"), "registry payload");
    assert.equal(await fs.readFile(path.join(cargoHome, ".global-cache"), "utf8"), "cargo gc state");
    assert.equal(await fs.readFile(path.join(cargoHome, "git", "db", "HEAD"), "utf8"), "git payload");
    assert.equal(await fs.readFile(path.join(cargoHome, "credentials.toml"), "utf8"), "secret must stay local");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("missing optional extras are valid and corrupt v2 registry restores fail visibly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cargo-registry-archive-"));
  const cargoHome = path.join(root, "cargo-home");
  const plan = planCargoRegistryArchive({
    format: "soldr-v2",
    cargoHome,
    runnerTemp: path.join(root, "runner-temp"),
  });
  try {
    await fs.mkdir(path.join(cargoHome, "registry"), { recursive: true });
    await fs.mkdir(path.dirname(plan.registryArchivePath), { recursive: true });
    await fs.writeFile(plan.registryArchivePath, "corrupt registry archive");
    await fs.writeFile(plan.extrasArchivePath, "empty extras archive");
    await assert.rejects(
      () =>
        restoreCargoRegistryArchive({
          plan,
          cargoHome,
          soldrPath: "fake-soldr",
          soldrVersion: "0.7.47",
          cacheKey: "exact-hit-key",
          operations: {
            restoreRegistry: async () => false,
            restoreExtras: async () => undefined,
          },
        }),
      /corrupt or incompatible/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
