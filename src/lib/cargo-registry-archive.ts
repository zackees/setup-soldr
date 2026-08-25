import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";

import type {
  CachePayloadCensus,
  CargoRegistryArchiveFormat,
  CargoRegistryArchivePlan,
} from "./types.js";
import { decompressCache } from "./cache-compress.js";
import {
  MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP,
  saveViaSoldr,
  semverGte,
  tryLoadViaSoldr,
} from "./soldr-load-shim.js";

const OPTIONAL_EXTRA_BASENAMES = [".global-cache", "git"] as const;

export function cargoRegistryArchiveFormat(input: {
  encrypted: boolean;
  viaSoldr: boolean;
  sourceRef: boolean;
  runtimeCompatible?: boolean;
}): CargoRegistryArchiveFormat {
  return input.viaSoldr && !input.encrypted && !input.sourceRef && input.runtimeCompatible !== false
    ? "soldr-v2"
    : "legacy-v1";
}

export function planCargoRegistryArchive(input: {
  format: CargoRegistryArchiveFormat;
  cargoHome: string;
  runnerTemp: string;
}): CargoRegistryArchivePlan {
  if (input.format === "legacy-v1") {
    const registryArchivePath = `${path.join(input.cargoHome, "registry")}.tar.zst`;
    return {
      format: input.format,
      registryArchivePath,
      extrasArchivePath: "",
      restorePaths: [registryArchivePath],
    };
  }
  const root = path.join(input.runnerTemp, "setup-soldr-cargo-registry", "v2");
  const registryArchivePath = path.join(root, "registry.soldr.tar.zst");
  const extrasArchivePath = path.join(root, "extras.tar.zst");
  return {
    format: input.format,
    registryArchivePath,
    extrasArchivePath,
    restorePaths: [registryArchivePath, extrasArchivePath],
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function cargoRegistryPayloadPaths(cargoHome: string): Promise<{
  registry: string;
  extras: string[];
}> {
  const registry = path.join(cargoHome, "registry");
  const extras: string[] = [];
  for (const basename of OPTIONAL_EXTRA_BASENAMES) {
    const candidate = path.join(cargoHome, basename);
    if (await exists(candidate)) extras.push(candidate);
  }
  return { registry, extras };
}

function runPipe(
  producer: [string, string[]],
  consumer: [string, string[]],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const prod = spawn(producer[0], producer[1], { stdio: ["ignore", "pipe", "inherit"] });
    const cons = spawn(consumer[0], consumer[1], { stdio: ["pipe", "inherit", "inherit"] });
    prod.once("error", reject);
    cons.once("error", reject);
    prod.stdout?.pipe(cons.stdin!);
    let producerExit: number | null = null;
    let consumerExit: number | null = null;
    const done = (): void => {
      if (producerExit === null || consumerExit === null) return;
      if (producerExit !== 0) reject(new Error(`${producer[0]} exited with code ${producerExit}`));
      else if (consumerExit !== 0) reject(new Error(`${consumer[0]} exited with code ${consumerExit}`));
      else resolve();
    };
    prod.once("close", (code) => { producerExit = code ?? 0; done(); });
    cons.once("close", (code) => { consumerExit = code ?? 0; done(); });
  });
}

const CARGO_REGISTRY_ZSTD_VERSION = "1.5.7";
const CARGO_REGISTRY_ZSTD_WIN64_SHA256 =
  "acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9";

export function cargoRegistryZstdAsset(arch = process.arch): string {
  if (arch === "ia32") {
    throw new Error("cargo-registry Soldr v2 does not support 32-bit Windows runners");
  }
  return `https://github.com/facebook/zstd/releases/download/v${CARGO_REGISTRY_ZSTD_VERSION}/zstd-v${CARGO_REGISTRY_ZSTD_VERSION}-win64.zip`;
}

async function findNamedFile(root: string, basename: string): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const nested = await findNamedFile(full, basename);
      if (nested) return nested;
    }
  }
  return null;
}

export async function resolveCargoRegistryZstd(): Promise<string> {
  const existing = await io.which("zstd", false);
  if (existing) return existing;
  if (process.platform !== "win32") {
    throw new Error("cargo-registry Soldr v2 requires zstd on PATH outside Windows");
  }
  const root = path.join(
    process.env["RUNNER_TEMP"] || os.tmpdir(),
    "setup-soldr-tools",
    `zstd-${CARGO_REGISTRY_ZSTD_VERSION}-${process.arch}`,
  );
  const cached = await findNamedFile(root, "zstd.exe");
  if (cached) return cached;
  await fs.mkdir(root, { recursive: true });
  const zipPath = path.join(root, "zstd.zip");
  await tc.downloadTool(cargoRegistryZstdAsset(), zipPath);
  const digest = createHash("sha256").update(await fs.readFile(zipPath)).digest("hex");
  if (digest !== CARGO_REGISTRY_ZSTD_WIN64_SHA256) {
    throw new Error(`downloaded zstd archive failed SHA-256 verification (got ${digest})`);
  }
  const extracted = await tc.extractZip(zipPath, path.join(root, "extracted"));
  const downloaded = await findNamedFile(extracted, "zstd.exe");
  if (!downloaded) throw new Error("downloaded zstd archive did not contain zstd.exe");
  return downloaded;
}

export async function writeCargoRegistryExtrasArchive(
  cargoHome: string,
  extras: string[],
  archivePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  const manifestRoot = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cargo-extras-"));
  const manifestPath = path.join(manifestRoot, "manifest.txt");
  try {
    const basenames = extras.map((entry) => path.basename(entry));
    await fs.writeFile(manifestPath, basenames.map((entry) => `${entry}\n`).join(""), "utf8");
    const zstd = await resolveCargoRegistryZstd();
    await runPipe(
      ["tar", ["-cf", "-", "-C", cargoHome, "-T", manifestPath]],
      [zstd, ["-T0", "-3", "-f", "-o", archivePath]],
    );
  } finally {
    await fs.rm(manifestRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function extractCargoRegistryExtrasArchive(
  cargoHome: string,
  archivePath: string,
): Promise<void> {
  const zstd = await resolveCargoRegistryZstd();
  await fs.mkdir(cargoHome, { recursive: true });
  await runPipe(
    [zstd, ["-d", "-T0", "-c", archivePath]],
    ["tar", ["-xf", "-", "-C", cargoHome]],
  );
}

export async function cargoRegistryPayloadCensus(
  cargoHome: string,
  topN: number,
): Promise<CachePayloadCensus> {
  const payload = await cargoRegistryPayloadPaths(cargoHome);
  const roots = [payload.registry, ...payload.extras];
  const topFiles: Array<{ path: string; bytes: number }> = [];
  const topDirectories: Array<{ path: string; bytes: number }> = [];
  const topSubtrees: Array<{ path: string; bytes: number; files: number }> = [];
  let bytes = 0;
  let files = 0;
  let symlinks = 0;
  let directories = 0;

  const walk = async (entry: string, relative: string): Promise<{ bytes: number; files: number }> => {
    let stat;
    try {
      stat = await fs.lstat(entry);
    } catch {
      return { bytes: 0, files: 0 };
    }
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      return { bytes: 0, files: 0 };
    }
    if (stat.isFile()) {
      bytes += stat.size;
      files += 1;
      topFiles.push({ path: relative, bytes: stat.size });
      return { bytes: stat.size, files: 1 };
    }
    if (!stat.isDirectory()) return { bytes: 0, files: 0 };
    directories += 1;
    let directoryBytes = 0;
    let directoryFiles = 0;
    for (const child of await fs.readdir(entry)) {
      const childStats = await walk(path.join(entry, child), path.join(relative, child));
      directoryBytes += childStats.bytes;
      directoryFiles += childStats.files;
    }
    topDirectories.push({ path: relative, bytes: directoryBytes });
    return { bytes: directoryBytes, files: directoryFiles };
  };

  for (const root of roots) {
    const basename = path.basename(root);
    const subtree = await walk(root, basename);
    topSubtrees.push({ path: basename, bytes: subtree.bytes, files: subtree.files });
  }
  const limit = Math.max(0, Math.min(50, Math.floor(topN)));
  topFiles.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  topDirectories.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  topSubtrees.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return {
    bytes,
    files,
    symlinks,
    directories,
    inputs: roots.map((entry) => path.basename(entry)),
    topFiles: topFiles.slice(0, limit),
    topDirectories: topDirectories.slice(0, limit),
    topSubtrees: topSubtrees.slice(0, limit),
    skipped: [],
  };
}

async function treeStats(target: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (entry: string): Promise<void> => {
    let stat;
    try { stat = await fs.lstat(entry); } catch { return; }
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(entry)) await walk(path.join(entry, child));
    } else if (stat.isFile()) {
      bytes += stat.size;
      files += 1;
    }
  };
  await walk(target);
  return { bytes, files };
}

async function payloadStats(cargoHome: string): Promise<{ bytes: number; files: number }> {
  const payload = await cargoRegistryPayloadPaths(cargoHome);
  const roots = [payload.registry, ...payload.extras];
  let bytes = 0;
  let files = 0;
  for (const root of roots) {
    const stats = await treeStats(root);
    bytes += stats.bytes;
    files += stats.files;
  }
  return { bytes, files };
}

export interface CargoRegistryArchiveResult {
  used: boolean;
  codecPath: "legacy-v1" | "soldr-v2" | "unsupported";
  archiveBytes: number;
  restoredBytes: number;
  restoredFiles: number;
  durationMs: number;
}

/** Injectable archive primitives keep payload orchestration independently testable. */
export interface CargoRegistryArchiveOperations {
  saveRegistry: (cacheDir: string, archivePath: string) => Promise<boolean>;
  restoreRegistry: (
    archivePath: string,
    targetDir: string,
  ) => Promise<{ used: boolean; restoredFiles: number | null; restoredBytes: number | null }>;
  saveExtras: (cargoHome: string, extras: string[], archivePath: string) => Promise<void>;
  restoreExtras: (cargoHome: string, archivePath: string) => Promise<void>;
}

export async function saveCargoRegistryArchive(input: {
  plan: CargoRegistryArchivePlan;
  cargoHome: string;
  soldrPath: string;
  soldrVersion: string;
  debug?: boolean;
  log?: (message: string) => void;
  operations?: Partial<CargoRegistryArchiveOperations>;
}): Promise<CargoRegistryArchiveResult> {
  const started = Date.now();
  const payload = await cargoRegistryPayloadPaths(input.cargoHome);
  if (input.plan.format !== "soldr-v2") {
    return { used: false, codecPath: "legacy-v1", archiveBytes: 0, restoredBytes: 0, restoredFiles: 0, durationMs: 0 };
  }
  if (!semverGte(input.soldrVersion, MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP)) {
    return { used: false, codecPath: "unsupported", archiveBytes: 0, restoredBytes: 0, restoredFiles: 0, durationMs: 0 };
  }
  await fs.mkdir(path.dirname(input.plan.registryArchivePath), { recursive: true });
  await Promise.all([
    fs.rm(input.plan.registryArchivePath, { force: true }),
    fs.rm(input.plan.extrasArchivePath, { force: true }),
  ]);
  const registrySaved = input.operations?.saveRegistry
    ? await input.operations.saveRegistry(payload.registry, input.plan.registryArchivePath)
    : (
        await saveViaSoldr({
          cacheDir: payload.registry,
          archivePath: input.plan.registryArchivePath,
          soldrPath: input.soldrPath,
          soldrVersion: input.soldrVersion,
          debug: input.debug,
          log: input.log,
        })
      ).used;
  if (!registrySaved) {
    throw new Error("Soldr v2 cargo-registry save did not produce a registry archive");
  }
  if (input.operations?.saveExtras) {
    await input.operations.saveExtras(
      input.cargoHome,
      payload.extras,
      input.plan.extrasArchivePath,
    );
  } else {
    await writeCargoRegistryExtrasArchive(
      input.cargoHome,
      payload.extras,
      input.plan.extrasArchivePath,
    );
  }
  const registryBytes = (await fs.stat(input.plan.registryArchivePath)).size;
  const extrasBytes = (await fs.stat(input.plan.extrasArchivePath)).size;
  const stats = await payloadStats(input.cargoHome);
  return {
    used: true,
    codecPath: "soldr-v2",
    archiveBytes: registryBytes + extrasBytes,
    restoredBytes: stats.bytes,
    restoredFiles: stats.files,
    durationMs: Date.now() - started,
  };
}

export async function restoreCargoRegistryArchive(input: {
  plan: CargoRegistryArchivePlan;
  cargoHome: string;
  soldrPath: string;
  soldrVersion: string;
  cacheKey: string;
  autoDefenderExclude?: boolean;
  debug?: boolean;
  log?: (message: string) => void;
  operations?: Partial<CargoRegistryArchiveOperations>;
}): Promise<CargoRegistryArchiveResult> {
  const started = Date.now();
  if (input.plan.format === "legacy-v1") {
    const result = await decompressCache({
      archivePath: input.plan.registryArchivePath,
      targetDir: path.join(input.cargoHome, "registry"),
      cacheKey: input.cacheKey,
      debug: input.debug,
      log: input.log,
    });
    return {
      used: true,
      codecPath: "legacy-v1",
      archiveBytes: result.archiveBytes,
      restoredBytes: result.inflatedBytes,
      restoredFiles: result.fileCount,
      durationMs: Date.now() - started,
    };
  }
  if (!semverGte(input.soldrVersion, MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP)) {
    return { used: false, codecPath: "unsupported", archiveBytes: 0, restoredBytes: 0, restoredFiles: 0, durationMs: 0 };
  }
  const registryRestore = input.operations?.restoreRegistry
    ? await input.operations.restoreRegistry(
        input.plan.registryArchivePath,
        path.join(input.cargoHome, "registry"),
      )
    : await tryLoadViaSoldr({
          archivePath: input.plan.registryArchivePath,
          targetDir: path.join(input.cargoHome, "registry"),
          soldrPath: input.soldrPath,
          soldrVersion: input.soldrVersion,
          autoDefenderExclude: input.autoDefenderExclude,
          debug: input.debug,
          log: input.log,
        });
  if (!registryRestore.used) {
    throw new Error("Soldr v2 cargo-registry archive is corrupt or incompatible");
  }
  const restoredFiles = registryRestore.restoredFiles;
  if (typeof restoredFiles !== "number" || !Number.isInteger(restoredFiles) || restoredFiles <= 0) {
    throw new Error(
      "Soldr v2 cargo-registry archive is unusable: restore reported no files",
    );
  }
  if (await exists(input.plan.extrasArchivePath)) {
    if (input.operations?.restoreExtras) {
      await input.operations.restoreExtras(input.cargoHome, input.plan.extrasArchivePath);
    } else {
      await extractCargoRegistryExtrasArchive(input.cargoHome, input.plan.extrasArchivePath);
    }
  }
  const registryBytes = (await fs.stat(input.plan.registryArchivePath)).size;
  const extrasBytes = await exists(input.plan.extrasArchivePath)
    ? (await fs.stat(input.plan.extrasArchivePath)).size
    : 0;
  return {
    used: true,
    codecPath: "soldr-v2",
    archiveBytes: registryBytes + extrasBytes,
    restoredBytes: registryRestore.restoredBytes ?? 0,
    restoredFiles,
    durationMs: Date.now() - started,
  };
}
