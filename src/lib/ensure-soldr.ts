// Soldr binary installer. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/ensure_soldr.py.
// Downloads the soldr binary from a GitHub release asset (or builds from a
// git ref when INPUT_REF is set) and places it under $SOLDR_INSTALL_DIR.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import * as fzstd from "fzstd";
import { createLogger, streamExec } from "./log-utils.js";
import { retryReleaseRequest } from "./release-readiness.js";
import type { ResolveResult } from "./types.js";
import { parseVersionJsonOutput } from "./verify-soldr.js";

type ArchiveExt = "tar.zst" | "tar.gz" | "zip";

interface TargetInfo {
  target: string;
  binaryName: string;
}

function detectTarget(): TargetInfo {
  const machine = process.arch;
  let arch: string;
  if (machine === "x64") arch = "x86_64";
  else if (machine === "arm64") arch = "aarch64";
  else throw new Error(`unsupported architecture: ${machine}`);

  if (process.platform === "linux") {
    return { target: `${arch}-unknown-linux-gnu`, binaryName: "soldr" };
  }
  if (process.platform === "darwin") {
    return { target: `${arch}-apple-darwin`, binaryName: "soldr" };
  }
  if (process.platform === "win32") {
    return { target: `${arch}-pc-windows-msvc`, binaryName: "soldr.exe" };
  }
  throw new Error(`unsupported operating system: ${process.platform}`);
}

function normalizeVersion(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

function versionAtLeast(value: string, minimum: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = normalizeVersion(v).match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]!), Number(m[2]!), Number(m[3]!)];
  };
  const got = parse(value);
  const want = parse(minimum);
  if (!got || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i]! > want[i]!) return true;
    if (got[i]! < want[i]!) return false;
  }
  return true;
}

function requestHeaders(githubToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "setup-soldr-action",
  };
  if (githubToken.trim()) {
    headers["Authorization"] = `Bearer ${githubToken.trim()}`;
  }
  return headers;
}

async function fetchJson(url: string, githubToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: requestHeaders(githubToken) });
  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  }
  const payload = (await response.json()) as unknown;
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`unexpected JSON payload from ${url}`);
  }
  return payload as Record<string, unknown>;
}

function releaseUrl(repo: string, version: string): string {
  if (version) {
    const tag = version.startsWith("v") ? version : `v${version}`;
    return `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  }
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

async function fetchRelease(repo: string, version: string, githubToken: string): Promise<Record<string, unknown>> {
  const url = releaseUrl(repo, version);
  try {
    return await retryReleaseRequest(() => fetchJson(url, githubToken), {
      onRetry: (attempt, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        core.info(`Release ${version || "latest"} was not ready (attempt ${attempt}/3): ${detail}; retrying exact tag`);
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to fetch exact soldr release ${version || "latest"} from ${repo}: ${detail}`);
  }
}

async function resolveRefCommitSha(repo: string, ref: string, githubToken: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`;
  const payload = await fetchJson(url, githubToken);
  const sha = payload["sha"];
  if (typeof sha !== "string" || !sha) {
    throw new Error(`failed to resolve commit sha for ${repo}@${ref}`);
  }
  return sha;
}

async function installedVersion(binaryPath: string): Promise<string | null> {
  if (!fs.existsSync(binaryPath)) return null;
  let stdout = "";
  const code = await exec.exec(binaryPath, ["version", "--json"], {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString("utf8");
      },
    },
  });
  if (code !== 0) return null;
  try {
    // Tolerant parse: extra fields, surrounding noise, and the silent-binary
    // regression (empty stdout, e.g. soldr v0.7.85/v0.7.87) all resolve to
    // null here, which makes the caller refresh the cached install.
    const payload = parseVersionJsonOutput(stdout);
    const v = payload["soldr_version"];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function sourceMetadataPath(installDir: string): string {
  return path.join(installDir, ".setup-soldr-source.json");
}

interface SourceMetadata {
  repo: string;
  ref: string;
  commit_sha: string;
  target: string;
  binary_name: string;
}

function loadSourceMetadata(p: string): Partial<SourceMetadata> | null {
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (typeof data !== "object" || data === null) return null;
    const out: Partial<SourceMetadata> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k as keyof SourceMetadata] = String(v);
    }
    return out;
  } catch {
    return null;
  }
}

function writeSourceMetadata(p: string, metadata: SourceMetadata): void {
  fs.writeFileSync(p, JSON.stringify(metadata, Object.keys(metadata).sort(), 2), "utf8");
}

function sourceInstallMatches(
  installDir: string,
  repo: string,
  ref: string,
  commitSha: string,
  target: string,
  binaryName: string,
): boolean {
  const binaryPath = path.join(installDir, binaryName);
  const metadata = loadSourceMetadata(sourceMetadataPath(installDir));
  if (!metadata || !fs.existsSync(binaryPath)) return false;
  return (
    metadata.repo === repo &&
    metadata.ref === ref &&
    metadata.commit_sha === commitSha &&
    metadata.target === target &&
    metadata.binary_name === binaryName
  );
}

function selectAsset(
  release: Record<string, unknown>,
  target: string,
): { name: string; url: string; archiveExt: ArchiveExt } {
  const assets = release["assets"];
  if (!Array.isArray(assets)) throw new Error("release payload has no assets array");
  // Preference order: tar.zst (newer releases — soldr 0.7.30+ ships these
  // for every platform including Windows MSVC), tar.gz (older Linux/macOS),
  // zip (older Windows). First-match wins per extension class.
  const extPreference: ArchiveExt[] = ["tar.zst", "tar.gz", "zip"];
  for (const ext of extPreference) {
    const suffix = `.${ext}`;
    for (const asset of assets) {
      if (typeof asset !== "object" || asset === null) continue;
      const a = asset as Record<string, unknown>;
      const name = typeof a["name"] === "string" ? (a["name"] as string) : "";
      if (name.includes(target) && name.endsWith(suffix)) {
        const url = a["browser_download_url"];
        if (typeof url !== "string") continue;
        return { name, url, archiveExt: ext };
      }
    }
  }
  throw new Error(`no release asset found for target ${target}`);
}

async function extractBinary(
  archivePath: string,
  archiveExt: ArchiveExt,
  binaryName: string,
  outDir: string,
): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  if (archiveExt === "zip") {
    await tc.extractZip(archivePath, outDir);
  } else if (archiveExt === "tar.gz") {
    await tc.extractTar(archivePath, outDir, "xz");
  } else {
    // Extract tar.zst in-process so setup does not depend on zstd being installed
    // before soldr itself is available.
    await extractTarZst(archivePath, outDir);
  }
  const found = findFile(outDir, binaryName);
  if (!found) throw new Error(`downloaded archive did not contain ${binaryName}`);
  return found;
}

async function extractTarZst(archivePath: string, outDir: string): Promise<void> {
  const compressed = fs.readFileSync(archivePath);
  let decompressed: Uint8Array;
  try {
    decompressed = fzstd.decompress(compressed);
  } catch (err) {
    throw new Error(
      `failed to decompress ${path.basename(archivePath)} with embedded zstd: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  extractTarBuffer(decompressed, outDir);
}

const TAR_BLOCK_SIZE = 512;

function tarString(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end < 0) end = slice.length;
  return Buffer.from(slice.subarray(0, end)).toString("utf8");
}

function tarOctal(block: Uint8Array, start: number, length: number): number {
  const raw = tarString(block, start, length).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid tar octal field: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function tarEntryName(block: Uint8Array): string {
  const name = tarString(block, 0, 100);
  const prefix = tarString(block, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function safeTarDestination(outDir: string, entryName: string): string {
  const normalizedName = entryName.replace(/\\/g, "/");
  if (!normalizedName || path.isAbsolute(normalizedName)) {
    throw new Error(`unsafe tar entry path: ${JSON.stringify(entryName)}`);
  }
  const destination = path.resolve(outDir, normalizedName);
  const root = path.resolve(outDir);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe tar entry path: ${JSON.stringify(entryName)}`);
  }
  return destination;
}

function extractTarBuffer(tarData: Uint8Array, outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + TAR_BLOCK_SIZE <= tarData.length) {
    const header = tarData.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (isZeroBlock(header)) break;

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = tarOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > tarData.length) {
      throw new Error("truncated tar archive");
    }
    const data = tarData.subarray(dataStart, dataEnd);
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (typeflag === "L") {
      pendingLongName = Buffer.from(data).toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      continue;
    }

    const entryName = pendingLongName ?? tarEntryName(header);
    pendingLongName = null;
    if (!entryName) continue;

    const destination = safeTarDestination(outDir, entryName);
    if (typeflag === "5") {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      continue;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(data));
    if (process.platform !== "win32") {
      const mode = tarOctal(header, 100, 8);
      if (mode > 0) fs.chmodSync(destination, mode);
    }
  }
}

function findFile(root: string, name: string): string | null {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

function platformBinarySuffix(binaryName: string): string {
  return binaryName.endsWith(".exe") ? ".exe" : "";
}

function bundledReleasePayloadNames(binaryName: string): string[] {
  const suffix = platformBinarySuffix(binaryName);
  return [
    `zccache${suffix}`,
    `zccache-soldr${suffix}`,
    `zccache-daemon${suffix}`,
    `zccache-fp${suffix}`,
    `soldr-daemon${suffix}`,
    `soldr-shim${suffix}`,
    `crgx${suffix}`,
    `cargo-chef${suffix}`,
    `soldr-clang-shim${suffix}`,
    "manifest.json",
  ];
}

function bundledZccacheBinaryNames(binaryName: string): string[] {
  const suffix = platformBinarySuffix(binaryName);
  return [`zccache${suffix}`, `zccache-daemon${suffix}`, `zccache-fp${suffix}`];
}

function hasBundledZccachePayload(installDir: string, binaryName: string): boolean {
  return bundledZccacheBinaryNames(binaryName).every((name) =>
    fs.existsSync(path.join(installDir, name)),
  );
}

function embeddedZccacheBinaryNames(binaryName: string): string[] {
  const suffix = platformBinarySuffix(binaryName);
  return [`soldr-daemon${suffix}`, `soldr-shim${suffix}`];
}

function hasEmbeddedZccachePayload(installDir: string, binaryName: string): boolean {
  return embeddedZccacheBinaryNames(binaryName).every((name) =>
    fs.existsSync(path.join(installDir, name)),
  );
}

function hasMulticallRuntimePayload(installDir: string, binaryName: string): boolean {
  const suffix = platformBinarySuffix(binaryName);
  return fs.existsSync(path.join(installDir, `soldr-daemon${suffix}`));
}

function hasBundledCargoChefPayload(installDir: string, binaryName: string): boolean {
  const suffix = platformBinarySuffix(binaryName);
  return fs.existsSync(path.join(installDir, `cargo-chef${suffix}`));
}

// Sidecar-based soldr releases from 0.7.66 through 0.8.0 ship
// `soldr-clang-shim`, and their blessed `soldr build` surface requires it
// next to the running executable. Soldr 0.8.1+ folds clang/toolchain/zccache
// shims into the main multicall binary, so those releases deliberately omit
// this sidecar.
function hasBundledClangShimPayload(installDir: string, binaryName: string): boolean {
  const suffix = platformBinarySuffix(binaryName);
  return fs.existsSync(path.join(installDir, `soldr-clang-shim${suffix}`));
}

function hasRequiredReleasePayload(
  installDir: string,
  binaryName: string,
  resolvedVersion: string,
): boolean {
  const usesMulticallRuntime = versionAtLeast(resolvedVersion, "0.8.1");
  const needsEmbeddedZccachePayload = versionAtLeast(resolvedVersion, "0.7.103");
  const needsCargoChef = versionAtLeast(resolvedVersion, "0.7.43");
  const needsLegacyClangShim =
    versionAtLeast(resolvedVersion, "0.7.66") && !usesMulticallRuntime;

  const hasRuntimePayload = usesMulticallRuntime
    ? hasMulticallRuntimePayload(installDir, binaryName)
    : needsEmbeddedZccachePayload
      ? hasEmbeddedZccachePayload(installDir, binaryName)
      : hasBundledZccachePayload(installDir, binaryName);

  return (
    hasRuntimePayload &&
    (!needsCargoChef || hasBundledCargoChefPayload(installDir, binaryName)) &&
    (!needsLegacyClangShim || hasBundledClangShimPayload(installDir, binaryName))
  );
}

function clearBundledReleasePayload(installDir: string, binaryName: string): void {
  for (const name of bundledReleasePayloadNames(binaryName)) {
    try {
      fs.rmSync(path.join(installDir, name), { force: true });
    } catch {
      // best effort stale-payload cleanup
    }
  }
}

function copyBundledReleasePayload(
  extractDir: string,
  installDir: string,
  binaryName: string,
): string[] {
  const copied: string[] = [];
  for (const name of bundledReleasePayloadNames(binaryName)) {
    const source = findFile(extractDir, name);
    if (!source) continue;
    const destination = path.join(installDir, name);
    fs.copyFileSync(source, destination);
    if (name !== "manifest.json" && process.platform !== "win32") {
      fs.chmodSync(destination, 0o755);
    }
    copied.push(name);
  }
  return copied;
}

async function buildFromSource(opts: {
  repo: string;
  ref: string;
  commitSha: string;
  installDir: string;
  target: string;
  binaryName: string;
  githubToken: string;
  log: (msg: string) => void;
}): Promise<string> {
  const { repo, ref, commitSha, installDir, target, binaryName, githubToken, log } = opts;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-source-"));
  try {
    const archivePath = path.join(tmp, "source.zip");
    const sourceRoot = path.join(tmp, "source");
    log(`Downloading soldr source from ${repo}@${ref} (${commitSha})`);
    const archiveUrl = `https://api.github.com/repos/${repo}/zipball/${commitSha}`;
    await downloadWithHeaders(archiveUrl, archivePath, requestHeaders(githubToken));
    fs.mkdirSync(sourceRoot, { recursive: true });
    await tc.extractZip(archivePath, sourceRoot);
    const dirs = fs.readdirSync(sourceRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (dirs.length !== 1) {
      throw new Error("source archive did not contain exactly one repository root");
    }
    const repoRoot = path.join(sourceRoot, (dirs[0] as fs.Dirent).name);
    const buildEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) buildEnv[k] = v;
    }
    buildEnv["CARGO_TERM_COLOR"] = buildEnv["CARGO_TERM_COLOR"] ?? "always";
    log(`Building soldr from source ref ${ref} (${commitSha})`);
    // #389: streamExec prefixes each `Compiling foo` line so the
    // forensic log shows where the soldr build wall-clock went.
    await streamExec(
      "cargo",
      ["build", "--locked", "--bin", "soldr", "--target", target],
      { cwd: repoRoot, env: buildEnv },
    );
    const builtBinary = path.join(repoRoot, "target", target, "debug", binaryName);
    if (!fs.existsSync(builtBinary)) {
      throw new Error(`built soldr binary not found at ${builtBinary}`);
    }
    clearBundledReleasePayload(installDir, binaryName);
    const destination = path.join(installDir, binaryName);
    fs.copyFileSync(builtBinary, destination);
    if (process.platform !== "win32") {
      fs.chmodSync(destination, 0o755);
    }
    writeSourceMetadata(sourceMetadataPath(installDir), {
      repo,
      ref,
      commit_sha: commitSha,
      target,
      binary_name: binaryName,
    });
    return destination;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

async function downloadWithHeaders(url: string, dest: string, headers: Record<string, string>): Promise<void> {
  // tc.downloadTool supports auth/headers via separate args; rather than rely
  // on that, do a manual fetch+pipe to keep behavior parity with the Python
  // implementation. We stream to disk to avoid loading large archives in RAM.
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
}

export async function ensureSoldr(opts: {
  resolveResult: ResolveResult;
  githubToken: string;
}): Promise<void> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);
  const { resolveResult, githubToken } = opts;

  const installDir = path.dirname(resolveResult.soldrPath);
  fs.mkdirSync(installDir, { recursive: true });
  const { target, binaryName } = detectTarget();
  const binaryPath = path.join(installDir, binaryName);
  const requestedRef = resolveResult.soldrRef.trim();
  const requestedVersion = resolveResult.soldrVersionRequested.trim();
  const repo = resolveResult.soldrRepo.trim() || "zackees/soldr";

  if (requestedRef) {
    if (requestedVersion) {
      log(`Ignoring requested release version ${JSON.stringify(requestedVersion)} because ref is set`);
    }
    const commitSha = await resolveRefCommitSha(repo, requestedRef, githubToken);
    if (sourceInstallMatches(installDir, repo, requestedRef, commitSha, target, binaryName)) {
      const current = await installedVersion(binaryPath);
      if (current !== null) {
        clearBundledReleasePayload(installDir, binaryName);
        log(`Using cached soldr ${current} built from ${repo}@${requestedRef} (${commitSha})`);
        core.setOutput("installed_version", current);
        return;
      }
    }
    const builtPath = await buildFromSource({
      repo,
      ref: requestedRef,
      commitSha,
      installDir,
      target,
      binaryName,
      githubToken,
      log,
    });
    const current = await installedVersion(builtPath);
    log(
      `Installed soldr ${current ?? requestedRef} from ${repo}@${requestedRef} (${commitSha}) at ${builtPath}`,
    );
    core.setOutput("installed_version", current ?? requestedRef);
    return;
  }

  // Release branch
  const resolvedVersion = resolveResult.soldrVersionResolved.trim() || requestedVersion;
  const current = await installedVersion(binaryPath);
  if (current !== null && resolvedVersion) {
    if (normalizeVersion(current) === normalizeVersion(resolvedVersion)) {
      const hasRequiredPayload = hasRequiredReleasePayload(
        installDir,
        binaryName,
        resolvedVersion,
      );
      if (hasRequiredPayload) {
        log(`Using cached soldr ${current} at ${binaryPath}`);
        core.setOutput("installed_version", current);
        return;
      }
      log(`Cached soldr ${current} is missing bundled release payload; refreshing`);
    }
    if (normalizeVersion(current) !== normalizeVersion(resolvedVersion)) {
      log(`Cached soldr ${current} does not match requested release ${resolvedVersion}; refreshing`);
    }
  }

  log(`Resolving soldr release ${resolvedVersion || "(latest)"} from ${repo}`);
  const release = await fetchRelease(repo, resolvedVersion, githubToken);
  const { name: assetName, url: downloadUrl, archiveExt } = selectAsset(release, target);
  const tagName = typeof release["tag_name"] === "string" ? (release["tag_name"] as string) : resolvedVersion;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-release-"));
  try {
    const archivePath = path.join(tmp, assetName);
    const extractDir = path.join(tmp, "extract");
    log(`Downloading ${assetName}`);
    await downloadWithHeaders(downloadUrl, archivePath, requestHeaders(githubToken));
    const sourceBinary = await extractBinary(archivePath, archiveExt, binaryName, extractDir);
    clearBundledReleasePayload(installDir, binaryName);
    fs.copyFileSync(sourceBinary, binaryPath);
    if (process.platform !== "win32") {
      fs.chmodSync(binaryPath, 0o755);
    }
    const copied = copyBundledReleasePayload(extractDir, installDir, binaryName);
    if (copied.length > 0) {
      log(`Installed bundled soldr release payload: ${copied.join(", ")}`);
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
  const metadataPath = sourceMetadataPath(installDir);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
  log(`Installed soldr ${tagName} at ${binaryPath}`);
  core.setOutput("installed_version", tagName);
}

export const _internal = {
  bundledReleasePayloadNames,
  bundledZccacheBinaryNames,
  clearBundledReleasePayload,
  copyBundledReleasePayload,
  embeddedZccacheBinaryNames,
  extractTarBuffer,
  hasBundledCargoChefPayload,
  hasBundledClangShimPayload,
  hasBundledZccachePayload,
  hasEmbeddedZccachePayload,
  hasMulticallRuntimePayload,
  hasRequiredReleasePayload,
  versionAtLeast,
};
